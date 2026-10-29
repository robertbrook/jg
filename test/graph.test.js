import { test } from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import { instance } from "@viz-js/viz";
import schema from "../schema/json-graph-schema_v2.json" with { type: "json" };
import { analyzeSource, applyEdits, convertV1, getGraphs, graphStats, layoutSize, previewMode, toDot, pointer } from "../graph.js";
import { example } from "../example.js";

const json = value => JSON.stringify(value, null, 2);
const analyze = value => analyzeSource(typeof value === "string" ? value : json(value));
const codes = result => result.diagnostics.map(item => item.code);
const errors = result => result.diagnostics.filter(item => item.severity === "error");
const applyAll = (source, rounds = 10) => {
  for (let round = 0; round < rounds; round++) {
    const fix = analyzeSource(source).diagnostics.find(item => item.fixes?.length)?.fixes[0];
    if (!fix) break;
    source = applyEdits(source, fix.edits);
  }
  return source;
};

test("the example is valid and connected", () => {
  const result = analyze(example);
  assert.equal(result.summary.schema, "valid");
  assert.deepEqual(errors(result), []);
  const stats = graphStats(example.graph);
  assert.equal(stats.components, 1);
  assert.equal(stats.isolated, 0);
});

test("strict validity agrees with Ajv across a corpus", () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);
  const corpus = [
    example, { graph: {} }, { graphs: [] }, { graph: { nodes: { a: {} } } }, { graph: { edges: [] } },
    { graph: { nodes: { a: {}, b: {} }, edges: [{ source: "a", target: "b" }] } },
    { graph: { directed: "true", edges: [] } }, { graph: { nodes: [] , edges: [] } }, { graph: {}, graphs: [] },
    { graph: { edges: [{ sorce: "a", target: "b" }] } }, { graph: { nodes: { a: { colour: "red" } }, edges: [] } },
    { graph: { nodes: { a: {}, b: {} }, hyperedges: [{ source: ["a"], target: ["b"] }] } },
    { graph: { directed: false, nodes: { a: {} }, hyperedges: [{ nodes: ["a"] }] } },
    { graph: { edges: [], hyperedges: [] } }, null, [], 4, {}
  ];
  for (const document of corpus) {
    assert.equal(analyze(document).summary.strictValid, validate(document), JSON.stringify(document));
  }
});

test("graphs with neither edges nor hyperedges warn about oneOf ambiguity and offer edges: []", () => {
  const source = json({ graph: { nodes: { a: {} } } });
  const result = analyzeSource(source);
  assert.equal(result.summary.schema, "ambiguous");
  assert.deepEqual(errors(result), []);
  const warning = result.diagnostics.find(item => item.code === "schema-ambiguous-oneof");
  assert.equal(warning.severity, "warning");
  assert.equal(analyzeSource(applyEdits(source, warning.fixes[0].edits)).summary.schema, "valid");
});

test("reports the closest oneOf branch rather than every alternative", () => {
  const result = analyze({ graph: { directed: "true", edges: [] } });
  assert.deepEqual(errors(result).map(item => [item.code, item.path]), [["schema-type", "/graph/directed"]]);
  assert.match(errors(result)[0].message, /boolean/);
});

test("suggests renames for mistyped properties and points at the key", () => {
  const source = json({ graph: { nodes: { a: {}, b: {} }, edges: [{ sorce: "a", target: "b" }] } });
  const result = analyzeSource(source);
  const item = result.diagnostics.find(entry => entry.code === "schema-additional-property");
  assert.equal(item.suggestion, "source");
  assert.ok(source.slice(item.start).startsWith('"sorce"'));
  assert.ok(item.line > 1 && item.column > 1);
  assert.ok(item.fixes.some(fix => fix.label.includes('"source"')));
});

test("suggests the nearest node for unknown references", () => {
  const result = analyze({ graph: { nodes: { draft: {}, review: {} }, edges: [{ source: "Draft", target: "review" }] } });
  const item = result.diagnostics.find(entry => entry.code === "unknown-node");
  assert.equal(item.path, "/graph/edges/0/source");
  assert.equal(item.suggestion, "draft");
});

test("reports duplicate keys that JSON.parse would silently drop", () => {
  assert.ok(codes(analyzeSource('{"graph":{"nodes":{"a":{},"a":{}},"edges":[]}}')).includes("duplicate-key"));
});

test("syntax errors have positions and fixes that produce parseable JSON", () => {
  for (const source of ['{"graph": {"nodes": {},}}', '{"graph": {"nodes": {} "edges": []}}', '{"graph": {"edges": [], "directed": NaN}}', '{"graph": {"edges": []', '{"graph": {"label": "x']) {
    const [item] = analyzeSource(source).diagnostics;
    assert.equal(item.code, "syntax", source);
    assert.ok(item.line >= 1 && item.column >= 1, source);
    assert.ok(item.fixes.length, source);
    assert.doesNotThrow(() => JSON.parse(applyEdits(source, item.fixes[0].edits)), source);
  }
  assert.equal(analyzeSource("").diagnostics[0].code, "syntax");
});

test("applying fixes repeatedly repairs a broken document", () => {
  const source = json({ graph: { directed: "true", nodes: { draft: {}, review: {} }, edges: [{ sorce: "draft", target: "review", weight: 2 }, { source: "review", target: "Draft" }] } });
  const result = analyzeSource(applyAll(source));
  assert.deepEqual(errors(result), []);
  assert.equal(result.summary.schema, "valid");
  assert.deepEqual(result.document.graph.edges[0].metadata, { weight: 2 });
});

test("converts v1 documents to v2", () => {
  const { document, changed, notes } = convertV1({ graph: { nodes: [{ id: "a", label: "A", color: "red" }, { label: "B" }, { id: "a" }], edges: [{ source: 1, target: "a", style: "dashed" }] } });
  assert.ok(changed);
  assert.deepEqual(Object.keys(document.graph.nodes), ["a", "node-2"]);
  assert.deepEqual(document.graph.nodes.a, { label: "A", metadata: { color: "red" } });
  assert.deepEqual(document.graph.edges[0], { source: "1", target: "a", metadata: { style: "dashed" } });
  assert.ok(notes.length >= 3);
  assert.equal(convertV1(example).changed, false);
});

test("handles prototype-like IDs and JSON pointer escaping", () => {
  const result = analyzeSource('{"graph":{"nodes":{"__proto__":{},"constructor":{}},"edges":[{"source":"__proto__","target":"constructor"}]}}');
  assert.deepEqual(errors(result), []);
  assert.equal(pointer("/graph/nodes", "a/b~c"), "/graph/nodes/a~1b~0c");
  assert.deepEqual(getGraphs({ graphs: [{}, {}] }).map(item => item.path), ["/graphs/0", "/graphs/1"]);
});

test("chooses a preview mode by size", () => {
  const graph = count => ({ nodes: Object.fromEntries(Array.from({ length: count }, (_, index) => [`n${index}`, {}])), edges: [] });
  assert.equal(previewMode(graph(10)).mode, "full");
  assert.equal(previewMode(graph(1000)).mode, "compact");
  assert.equal(previewMode(graph(6000)).mode, "too-large");
  assert.deepEqual(layoutSize({ nodes: { a: {}, b: {} }, hyperedges: [{ nodes: ["a", "b"] }] }), { nodes: 3, links: 2 });
});

test("DOT output escapes labels, keeps hyperedge direction, and renders with Graphviz WASM", async () => {
  const viz = await instance();
  const full = toDot({ directed: false, nodes: { a: { label: 'say "hi"\\' }, b: {} }, hyperedges: [{ source: ["a"], target: ["b"], label: "h" }] });
  assert.match(full, /h0 -> n1 \[id="e0t0"\]/);
  assert.ok(full.includes(String.raw`label="say \"hi\"\\"`));
  assert.match(viz.renderString(full, { format: "svg" }), /say &quot;hi&quot;\\</);
  const compact = toDot(example.graph, { compact: true });
  assert.doesNotMatch(compact, /label="[^"]/);
  for (const [dot, engine] of [[full, "dot"], [toDot(example.graph), "dot"], [compact, "sfdp"]]) {
    assert.equal(viz.render(dot, { format: "svg", engine }).status, "success");
  }
});
