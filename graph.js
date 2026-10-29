export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_LAYOUT_NODES = 500;
export const MAX_LAYOUT_LINKS = 1500;

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
export const pointer = (base, key) => `${base}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;

export function getGraphs(document) {
  if (!object(document)) return [];
  if (Object.hasOwn(document, "graph")) return [{ graph: document.graph, path: "/graph" }];
  return Array.isArray(document.graphs) ? document.graphs.map((graph, index) => ({ graph, path: `/graphs/${index}` })) : [];
}

export function validateDocument(document) {
  const diagnostics = [];
  const report = (path, message, severity = "error") => diagnostics.push({ path, message, severity });
  function fields(value, path, allowed, required = []) {
    if (!object(value)) {
      report(path, "Expected an object.");
      return false;
    }
    for (const key of required) if (!Object.hasOwn(value, key)) report(pointer(path, key), `Missing required field "${key}".`);
    for (const [key, item] of Object.entries(value)) {
      const expected = allowed[key];
      if (!Object.hasOwn(allowed, key)) report(pointer(path, key), `Unknown field "${key}". Put custom data inside metadata.`);
      else if (!(expected === "object" ? object(item) : expected === "array" ? Array.isArray(item) : typeof item === expected)) {
        report(pointer(path, key), `Expected ${expected === "array" || expected === "object" ? "an" : "a"} ${expected}.`);
      }
    }
    return true;
  }
  if (!object(document)) {
    report("", 'Expected a document containing "graph" or "graphs".');
    return diagnostics;
  }
  const hasGraph = Object.hasOwn(document, "graph");
  const hasGraphs = Object.hasOwn(document, "graphs");
  if (hasGraph === hasGraphs) report("", 'Use exactly one of "graph" or "graphs".');
  for (const key of Object.keys(document)) if (key !== "graph" && key !== "graphs") report(pointer("", key), `Unknown document field "${key}".`);
  if (hasGraphs && !Array.isArray(document.graphs)) report("/graphs", "Expected an array of graph objects.");
  for (const { graph, path } of getGraphs(document)) {
    if (!fields(graph, path, { id: "string", label: "string", directed: "boolean", type: "string", metadata: "object", nodes: "object", edges: "array", hyperedges: "array" })) continue;
    if (Object.hasOwn(graph, "edges") && Object.hasOwn(graph, "hyperedges")) report(path, "A graph cannot contain both edges and hyperedges.");
    const nodes = object(graph.nodes) ? graph.nodes : {};
    for (const [id, node] of Object.entries(nodes)) fields(node, pointer(`${path}/nodes`, id), { label: "string", metadata: "object" });
    const ids = new Set();
    const reference = (id, location) => {
      if (typeof id === "string" && !Object.hasOwn(nodes, id)) report(location, `Node "${id}" does not exist in this graph.`);
    };
    const common = { id: "string", relation: "string", label: "string", metadata: "object" };
    const checkId = (edge, location) => {
      if (typeof edge.id !== "string") return;
      if (ids.has(edge.id)) report(`${location}/id`, `Duplicate edge ID "${edge.id}".`, "warning");
      ids.add(edge.id);
    };
    if (Array.isArray(graph.edges)) graph.edges.forEach((edge, index) => {
      const location = `${path}/edges/${index}`;
      if (!fields(edge, location, { ...common, source: "string", target: "string", directed: "boolean" }, ["source", "target"])) return;
      reference(edge.source, `${location}/source`);
      reference(edge.target, `${location}/target`);
      checkId(edge, location);
    });
    if (Array.isArray(graph.hyperedges)) graph.hyperedges.forEach((edge, index) => {
      const location = `${path}/hyperedges/${index}`;
      const undirected = graph.directed === false;
      const members = undirected ? ["nodes"] : ["source", "target"];
      const allowed = undirected ? { ...common, nodes: "array" } : { ...common, source: "array", target: "array" };
      if (!fields(edge, location, allowed, members)) return;
      for (const key of members) {
        if (!Array.isArray(edge[key])) continue;
        edge[key].forEach((id, memberIndex) => {
          const memberPath = `${location}/${key}/${memberIndex}`;
          if (typeof id !== "string") report(memberPath, "Expected a node ID string.");
          else reference(id, memberPath);
        });
      }
      checkId(edge, location);
    });
  }
  return diagnostics;
}

// JSON is parsed first; this token walk only indexes source ranges and duplicate keys.
function sourceLocations(source) {
  const locations = new Map();
  const duplicates = [];
  const stack = [];
  const tokens = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]:,]/g;
  const currentPath = () => {
    const parent = stack.at(-1);
    return parent ? pointer(parent.path, parent.type === "array" ? parent.index : parent.key) : "";
  };
  for (const match of source.matchAll(tokens)) {
    const token = match[0];
    const start = match.index;
    const parent = stack.at(-1);
    if (token === ":" || token === ",") {
      if (token === "," && parent) {
        if (parent.type === "array") parent.index++;
        else parent.expectKey = true;
      }
      continue;
    }
    if (token === "}" || token === "]") {
      const container = stack.pop();
      locations.get(container.path).end = start + 1;
      continue;
    }
    if (parent?.type === "object" && parent.expectKey) {
      parent.key = JSON.parse(token);
      parent.expectKey = false;
      if (parent.keys.has(parent.key)) duplicates.push({
        path: pointer(parent.path, parent.key), start,
        message: `Duplicate key "${parent.key}". JSON would keep only the last value.`, severity: "error", code: "duplicate-key"
      });
      parent.keys.add(parent.key);
      continue;
    }
    const path = currentPath();
    locations.set(path, { start, end: start + token.length });
    if (token === "{" || token === "[") stack.push({
      path, type: token === "{" ? "object" : "array", index: 0, key: "", expectKey: true, keys: new Set()
    });
  }
  return { locations, duplicates };
}

export function analyzeSource(source) {
  if (new TextEncoder().encode(source).length > MAX_SOURCE_BYTES) {
    return { document: null, locations: new Map(), diagnostics: [{ path: "", severity: "error", message: "Document exceeds the 2 MiB limit. Open a smaller document." }] };
  }
  let document;
  try {
    document = JSON.parse(source);
  } catch (error) {
    let start = Number(error.message.match(/position (\d+)/)?.[1] ?? 0);
    const lineColumn = error.message.match(/line (\d+) column (\d+)/);
    if (lineColumn) start = source.split("\n").slice(0, Number(lineColumn[1]) - 1).reduce((length, line) => length + line.length + 1, 0) + Number(lineColumn[2]) - 1;
    return { document: null, locations: new Map(), diagnostics: [{ path: "", start, message: error.message, severity: "error", code: "syntax" }] };
  }
  const { locations, duplicates } = sourceLocations(source);
  return { document, locations, diagnostics: [...duplicates, ...validateDocument(document)] };
}

export function graphStats(graph) {
  const keys = Object.keys(graph.nodes ?? {});
  const neighbors = new Map(keys.map(id => [id, new Set()]));
  const degree = new Map(keys.map(id => [id, 0]));
  const links = graph.edges ?? graph.hyperedges ?? [];
  for (const edge of links) {
    const members = graph.edges ? [edge.source, edge.target] : edge.nodes ?? [...edge.source, ...edge.target];
    const unique = [...new Set(members)];
    for (const id of unique) {
      degree.set(id, degree.get(id) + 1);
      if (id !== unique[0]) {
        neighbors.get(id).add(unique[0]);
        neighbors.get(unique[0]).add(id);
      }
    }
  }
  const seen = new Set();
  let components = 0;
  for (const id of keys) {
    if (seen.has(id)) continue;
    components++;
    const pending = [id];
    seen.add(id);
    while (pending.length) for (const next of neighbors.get(pending.pop())) if (!seen.has(next)) { seen.add(next); pending.push(next); }
  }
  return { nodes: keys.length, links: links.length, components, isolated: keys.filter(id => degree.get(id) === 0).length, degree };
}

function dotString(value) {
  return JSON.stringify(String(value).replaceAll("\\", "\\\\").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""));
}

export function toDot(graph, showLabels = true) {
  const ids = new Map(Object.keys(graph.nodes ?? {}).map((id, index) => [id, `n${index}`]));
  const lines = [
    "digraph G {",
    'graph [bgcolor="transparent", rankdir="TB", pad="0.35", nodesep="0.45", ranksep="0.6", overlap="false", splines="true", outputorder="edgesfirst"];',
    'node [shape="box", style="rounded,filled", fillcolor="#ffffff", color="#a6b8d0", fontcolor="#233346", fontname="Arial", fontsize="12", margin="0.18,0.12", penwidth="1.2"];',
    'edge [color="#8da1bc", fontcolor="#526781", fontname="Arial", fontsize="10", arrowsize="0.65"];'
  ];
  for (const [id, node] of Object.entries(graph.nodes ?? {})) {
    lines.push(`${ids.get(id)} [id="${ids.get(id)}", label=${dotString(node.label ?? id)}];`);
  }
  const attributes = (edge, index, directed) => `id="e${index}", dir="${directed ? "forward" : "none"}", label=${dotString(showLabels ? edge.label ?? edge.relation ?? "" : "")}`;
  if (graph.edges) graph.edges.forEach((edge, index) => {
    lines.push(`${ids.get(edge.source)} -> ${ids.get(edge.target)} [${attributes(edge, index, edge.directed ?? graph.directed ?? true)}];`);
  });
  if (graph.hyperedges) graph.hyperedges.forEach((edge, index) => {
    const directed = graph.directed !== false;
    lines.push(`h${index} [id="h${index}", shape="diamond", width="0.18", height="0.18", margin="0", label="", fillcolor="#dce7f7", tooltip="Hyperedge ${index + 1}"];`);
    const sources = directed ? edge.source : edge.nodes;
    for (const [memberIndex, id] of sources.entries()) lines.push(`${ids.get(id)} -> h${index} [id="e${index}s${memberIndex}", dir="none"];`);
    if (directed) for (const [memberIndex, id] of edge.target.entries()) lines.push(`h${index} -> ${ids.get(id)} [id="e${index}t${memberIndex}", arrowsize="0.65"];`);
    if (showLabels && (edge.label || edge.relation)) lines.push(`h${index} [xlabel=${dotString(edge.label ?? edge.relation)}];`);
  });
  return `${lines.join("\n")}\n}`;
}

export function layoutSize(graph) {
  return {
    nodes: Object.keys(graph.nodes ?? {}).length + (graph.hyperedges?.length ?? 0),
    links: graph.edges?.length ?? graph.hyperedges?.reduce((total, edge) => total + (edge.nodes?.length ?? edge.source.length + edge.target.length), 0) ?? 0
  };
}
