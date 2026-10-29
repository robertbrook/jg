import { test } from "node:test";
import assert from "node:assert/strict";
import { instance } from "@viz-js/viz";
import { analyzeSource, validateDocument, getGraphs, graphStats, layoutSize, toDot, pointer, MAX_SOURCE_BYTES } from "../graph.js";
import { example } from "../example.js";

test("the example is valid and connected", () => {
  assert.deepEqual(validateDocument(example), []);
  const stats = graphStats(example.graph);
  assert.equal(stats.nodes, 6);
  assert.equal(stats.links, 6);
  assert.equal(stats.components, 1);
  assert.equal(stats.isolated, 0);
});
test("empty, nodes-only, and multiple graphs are valid", () => {
  for (const document of [{ graph: {} }, { graphs: [] }, { graph: { nodes: { a: {} } } }, { graphs: [{}, {}] }]) {
    assert.deepEqual(validateDocument(document), []);
  }
  assert.deepEqual(getGraphs({ graphs: [{}, {}] }).map(item => item.path), ["/graphs/0", "/graphs/1"]);
});
test("requires exactly one document envelope", () => {
  for (const document of [null, [], 4, {}, { graph: {}, graphs: [] }, { graphs: {} }]) assert.ok(validateDocument(document).length);
});
test("validates field types, required endpoints, and custom data placement", () => {
  const result = validateDocument({ graph: { directed: "yes", nodes: { a: { color: "red", metadata: [] } }, edges: [{ target: 7 }] } });
  for (const path of ["/graph/directed", "/graph/nodes/a/color", "/graph/nodes/a/metadata", "/graph/edges/0/source", "/graph/edges/0/target"]) {
    assert.ok(result.some(item => item.path === path), path);
  }
});
test("rejects dangling references and retains JSON pointer escaping", () => {
  const result = validateDocument({ graph: { nodes: { "a/b~c": {} }, edges: [{ source: "a/b~c", target: "missing" }] } });
  assert.equal(result.length, 1);
  assert.equal(result[0].path, "/graph/edges/0/target");
  assert.equal(pointer("/graph/nodes", "a/b~c"), "/graph/nodes/a~1b~0c");
});
test("handles prototype-like keys as ordinary IDs without inherited references", () => {
  const document = JSON.parse('{"graph":{"nodes":{"__proto__":{},"constructor":{}},"edges":[{"source":"__proto__","target":"constructor"}]}}');
  assert.deepEqual(validateDocument(document), []);
  assert.equal(graphStats(document.graph).components, 1);
  assert.ok(validateDocument({ graph: { edges: [{ source: "constructor", target: "toString" }] } }).length === 2);
});
test("validates all graphs, not just the selected one", () => {
  assert.equal(validateDocument({ graphs: [{}, { nodes: [] }] })[0].path, "/graphs/1/nodes");
});
test("accepts directed and undirected hyperedges and checks each member", () => {
  for (const graph of [
    { nodes: { a: {}, b: {} }, hyperedges: [{ source: ["a"], target: ["b"] }] },
    { directed: false, nodes: { a: {}, b: {} }, hyperedges: [{ nodes: ["a", "b"] }] }
  ]) {
    assert.deepEqual(validateDocument({ graph }), []);
    assert.equal(graphStats(graph).components, 1);
    assert.deepEqual(layoutSize(graph), { nodes: 3, links: 2 });
  }
  const diagnostics = validateDocument({ graph: { hyperedges: [{ source: ["missing", 3], target: [] }] } });
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.some(item => item.path === "/graph/hyperedges/0/source/1"));
});
test("does not mix edges and hyperedges or hyperedge direction forms", () => {
  assert.ok(validateDocument({ graph: { edges: [], hyperedges: [] } }).length);
  assert.ok(validateDocument({ graph: { hyperedges: [{ nodes: [] }] } }).length);
  assert.ok(validateDocument({ graph: { directed: false, hyperedges: [{ source: [], target: [] }] } }).length);
});
test("warns about duplicate edge IDs without rejecting parallel edges", () => {
  const graph = { nodes: { a: {} }, edges: [{ id: "x", source: "a", target: "a" }, { id: "x", source: "a", target: "a" }] };
  assert.deepEqual(validateDocument({ graph }).map(item => item.severity), ["warning"]);
  assert.equal(graphStats(graph).isolated, 0);
});
test("indexes exact source ranges, including escaped keys and nested metadata", () => {
  const source = '{ "graph": { "nodes": { "a/b~c": { "metadata": { "values": [1, {"ok": true}] } } } } }';
  const { locations, diagnostics } = analyzeSource(source);
  assert.deepEqual(diagnostics, []);
  const location = locations.get("/graph/nodes/a~1b~0c/metadata/values/1/ok");
  assert.equal(source.slice(location.start, location.end), "true");
  const nodeLocation = locations.get("/graph/nodes/a~1b~0c");
  assert.deepEqual(JSON.parse(source.slice(nodeLocation.start, nodeLocation.end)), { metadata: { values: [1, { ok: true }] } });
});
test("detects duplicate keys at any depth before data can be lost", () => {
  const result = analyzeSource('{"graph":{"nodes":{"a":{},"a":{"metadata":{"x":1,"x":2}}}}}');
  assert.equal(result.diagnostics.filter(item => item.code === "duplicate-key").length, 2);
  assert.ok(result.diagnostics.every(item => Number.isInteger(item.start)));
});
test("reports invalid JSON and oversized input", () => {
  const invalid = analyzeSource('{"graph": invalid}');
  assert.equal(invalid.diagnostics[0].code, "syntax");
  assert.ok(Number.isInteger(invalid.diagnostics[0].start));
  assert.match(analyzeSource(" ".repeat(MAX_SOURCE_BYTES + 1)).diagnostics[0].message, /2 MiB/);
});
test("counts weak components and isolated nodes without assuming direction", () => {
  const stats = graphStats({ nodes: { a: {}, b: {}, c: {}, d: {} }, edges: [{ source: "a", target: "b" }] });
  assert.equal(stats.components, 3);
  assert.equal(stats.isolated, 2);
});
test("WASM renders ordinary and hyperedge layouts in all supported engines", async () => {
  const viz = await instance();
  const graphs = [
    example.graph,
    { directed: false, nodes: { a: {}, b: {} }, hyperedges: [{ nodes: ["a", "b"], label: "group" }] },
    { nodes: { a: {}, b: {} }, hyperedges: [{ source: ["a"], target: ["b"] }] }
  ];
  for (const engine of ["dot", "neato", "circo"]) for (const graph of graphs) {
    const result = viz.render(toDot(graph), { format: "svg", engine });
    assert.equal(result.status, "success", JSON.stringify(result.errors));
    assert.match(result.output, /<svg/);
    assert.match(result.output, /id="n0"/);
  }
});
test("labels cannot inject DOT, HTML, external links, or Graphviz substitutions", async () => {
  const viz = await instance();
  const label = '<script>alert(1)</script> "]; evil [URL="https://invalid.test"]; // \\N';
  const graph = { nodes: { 'a"b': { label } } };
  const output = viz.renderString(toDot(graph), { format: "svg" });
  assert.doesNotMatch(output, /<script>|<a |xlink:href=/);
  assert.match(output, /&lt;script&gt;/);
  assert.match(output, /\\N/);
  assert.equal((output.match(/class="node"/g) ?? []).length, 1);
});
test("edge direction overrides inheritance, and labels can be switched off", () => {
  const graph = { directed: false, nodes: { a: {} }, edges: [{ source: "a", target: "a", directed: true, label: "Loop" }] };
  assert.match(toDot(graph), /dir="forward", label="Loop"/);
  assert.match(toDot(graph, false), /dir="forward", label=""/);
});
