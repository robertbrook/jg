import schema from "./schema/json-graph-schema_v2.json" with { type: "json" };
import { createValidator, closestBranch, typeOf } from "./schema-validator.js";

export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_LAYOUT_NODES = 500;
export const MAX_LAYOUT_LINKS = 1500;
export const MAX_COMPACT_NODES = 5000;
export const MAX_COMPACT_LINKS = 15000;
export const SCHEMA = { id: schema.$id, file: "json-graph-schema_v2.json", dialect: "JSON Schema draft-07" };

const object = value => typeOf(value) === "object";
const validateSchema = createValidator(schema);
export const pointer = (base, key) => `${base}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
const segments = path => path.split("/").slice(1).map(key => key.replaceAll("~1", "/").replaceAll("~0", "~"));
const quote = value => JSON.stringify(String(value));
const list = (items, joiner = "or") => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${joiner} ${items.at(-1)}`;
const article = type => ({ object: "an object", array: "an array", integer: "an integer", null: "null" })[type] ?? `a ${type}`;
const DEFINITION_NAMES = { graph: "graph", node: "node", edge: "edge", directedhyperedge: "directed hyperedge", undirectedhyperedge: "undirected hyperedge" };

export function getGraphs(document) {
  if (!object(document)) return [];
  if (Object.hasOwn(document, "graph")) return [{ graph: document.graph, path: "/graph" }];
  return Array.isArray(document.graphs) ? document.graphs.map((graph, index) => ({ graph, path: `/graphs/${index}` })) : [];
}

export function preview(value) {
  const type = typeOf(value);
  if (type === "object") return `{…} (${Object.keys(value).length} ${Object.keys(value).length === 1 ? "property" : "properties"})`;
  if (type === "array") return `[…] (${value.length} ${value.length === 1 ? "item" : "items"})`;
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}…"` : text;
}

export function humanPath(path, document) {
  if (!path) return "document root";
  let value = document;
  let text = "";
  for (const key of segments(path)) {
    if (Array.isArray(value)) text += `[${key}]`;
    else text += /^[A-Za-z_$][\w$-]*$/.test(key) ? `${text ? "." : ""}${key}` : `[${quote(key)}]`;
    value = value !== null && typeof value === "object" && Object.hasOwn(value, key) ? value[key] : undefined;
  }
  return text;
}

function kindOf(schemaPath) {
  const name = schemaPath.match(/#\/definitions\/([^/]+)/g)?.at(-1)?.split("/").at(-1);
  return DEFINITION_NAMES[name] ?? "document";
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}
function suggest(value, options) {
  const exact = options.find(option => option.toLowerCase() === value.toLowerCase());
  if (exact) return exact;
  const [best] = options.map(option => ({ option, score: distance(value.toLowerCase(), option.toLowerCase()) })).sort((a, b) => a.score - b.score);
  return best && best.score <= Math.max(1, Math.floor(value.length / 3)) ? best.option : null;
}

function typeHint(error) {
  const field = segments(error.instancePath).at(-1);
  const { found, value } = error;
  if (field === "nodes" && found === "array" && error.expected.includes("object")) {
    return 'JSON Graph v2 stores nodes in an object keyed by node ID, such as "nodes": { "A": { "label": "A" } }. A nodes array is JSON Graph v1 syntax.';
  }
  if (field === "metadata") return 'metadata must be a JSON object, such as "metadata": { "weight": 3 }.';
  if (error.expected.includes("boolean") && (value === "true" || value === "false")) return `Remove the quotes: use ${value} rather than "${value}".`;
  if (error.expected.includes("string") && (found === "integer" || found === "number")) return `Wrap the value in quotes: "${value}". Node IDs and references are strings.`;
  if (error.expected.includes("array") && found === "object") return "Use square brackets [ … ] for a list of items.";
  if (error.expected.includes("object") && found === "array") return "Use braces { … } with named properties instead of an array.";
  return null;
}

function reasonFor(branch, document) {
  const errors = branch.errors.filter(error => !error.ambiguous);
  const first = errors[0];
  if (!first) return "matches";
  if (first.keyword === "oneOf" || first.keyword === "anyOf") return reasonFor(closestBranch(first), document);
  const described = describe(first, document, []);
  return `${described.title}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ""}`;
}

function describe(error, document, context) {
  const kind = kindOf(error.schemaPath);
  const where = humanPath(error.instancePath, document);
  const field = error.instancePath ? quote(segments(error.instancePath).at(-1)) : "the document";
  const base = { severity: "error", category: "schema", keyword: error.keyword, schemaPath: error.schemaPath, path: error.instancePath, context };
  switch (error.keyword) {
    case "type": return {
      ...base, code: "schema-type",
      title: `Wrong type for ${field}`,
      message: `The ${kind} schema requires ${field} at ${where} to be ${list(error.expected.map(article))}, but the document has ${article(error.found)}.`,
      expected: list(error.expected.map(article)), found: `${article(error.found)}: ${preview(error.value)}`, hint: typeHint(error),
      expectedTypes: error.expected, value: error.value
    };
    case "required": {
      const roles = { source: "the source node ID", target: "the target node ID", nodes: "the member node IDs", directed: "false", graph: "a graph object" };
      let hint = `Add ${quote(error.property)} to this ${kind}.`;
      if (kind === "edge") hint = `Add "${error.property}": "<node id>", using a key from this graph's "nodes" object.`;
      if (kind.includes("hyperedge") && error.property !== "directed") hint = `Add "${error.property}": [ … ] containing ${roles[error.property]}.`;
      if (error.property === "directed") hint = 'Undirected hyperedges ("nodes": [ … ]) are allowed only when the graph declares "directed": false. Either add that, or use "source" and "target" arrays.';
      return {
        ...base, code: "schema-required", title: `Missing required property ${quote(error.property)}`,
        message: `Every ${kind === "graph" && context.length ? context.at(-1).chosen.replace(/ \(requires.*\)$/, "") : kind} must include ${list(error.expected.map(quote), "and")}. This ${kind} (${where}) has no ${quote(error.property)}.`,
        expected: `property ${quote(error.property)}`, found: `${preview(error.value)} without ${quote(error.property)}`, hint,
        property: error.property, objectPath: error.instancePath
      };
    }
    case "additionalProperties": {
      const suggestion = suggest(error.property, error.allowed);
      let hint = suggestion ? `Did you mean ${quote(suggestion)}? Property names are case-sensitive.` : null;
      if (!hint && kind === "document") hint = 'The top level may contain only "graph" (one graph) or "graphs" (an array of graphs).';
      if (!hint && kind === "graph" && ["edges", "hyperedges"].includes(error.property)) hint = 'A graph may contain "edges" or "hyperedges", but not both.';
      if (!hint && error.allowed.includes("metadata")) hint = `Custom data belongs in "metadata", for example "metadata": { ${quote(error.property)}: … }.`;
      return {
        ...base, code: "schema-additional-property", path: pointer(error.instancePath, error.property),
        title: `Unexpected property ${quote(error.property)}`,
        message: `The ${kind} schema sets "additionalProperties": false. At ${where}, only ${list(error.allowed.map(quote))} are allowed, so ${quote(error.property)} is rejected.`,
        expected: `one of ${list(error.allowed.map(quote))}`, found: quote(error.property), hint,
        suggestion, property: error.property, objectPath: error.instancePath, canMoveToMetadata: error.allowed.includes("metadata")
      };
    }
    case "enum": case "const": return {
      ...base, code: `schema-${error.keyword}`, title: `Value not allowed for ${field}`,
      message: `At ${where}, the ${kind} schema allows only ${list(error.expected.map(item => JSON.stringify(item)))}.`,
      expected: list(error.expected.map(item => JSON.stringify(item))), found: preview(error.value),
      hint: kind === "graph" && error.instancePath.endsWith("/directed") ? 'Graphs with undirected hyperedges ("nodes": [ … ]) must declare "directed": false.' : null
    };
    default: return {
      ...base, code: `schema-${error.keyword}`, title: `Schema rule "${error.keyword}" failed`,
      message: `The value at ${where} does not satisfy "${error.keyword}" (${JSON.stringify(error.expected ?? null)}).`,
      expected: JSON.stringify(error.expected ?? null), found: preview(error.value), hint: null
    };
  }
}

function ambiguity(error, document, context) {
  const kind = kindOf(error.schemaPath);
  const value = error.value;
  const labels = error.passing.map(index => error.branches[index].label);
  let hint = 'Make the data match only one alternative, for example by adding an explicit "edges" or "hyperedges" array.';
  if (kind === "graph" && object(value) && !Object.hasOwn(value, "edges") && !Object.hasOwn(value, "hyperedges")) {
    hint = 'Known quirk of json-graph-schema_v2.json: a graph with neither "edges" nor "hyperedges" satisfies several alternatives. The specification README shows such graphs as valid, so this page still previews it. Add "edges": [] to satisfy strict validators.';
  } else if (kind === "graph" && Array.isArray(value?.hyperedges) && !value.hyperedges.length) {
    hint = 'An empty "hyperedges" array fits both hyperedge alternatives. Add a hyperedge, or use "edges": [] instead.';
  }
  return {
    severity: "warning", category: "schema", code: "schema-ambiguous-oneof", keyword: "oneOf",
    schemaPath: error.schemaPath, path: error.instancePath, context,
    title: `Matches ${labels.length} schema alternatives; strict validators reject this`,
    message: `"oneOf" requires exactly one alternative to match. The ${kind} at ${humanPath(error.instancePath, document)} matches ${labels.length} of ${error.branches.length}: ${list(labels, "and")}. Ajv and other draft-07 validators will report the document as invalid.`,
    expected: "exactly 1 matching alternative", found: `${labels.length} matching alternatives`, hint,
    addEdges: kind === "graph" && object(value) && !Object.hasOwn(value, "edges") && !Object.hasOwn(value, "hyperedges")
  };
}

function schemaDiagnostics(errors, document, context = []) {
  const diagnostics = [];
  for (const error of errors) {
    if (error.ambiguous) diagnostics.push(ambiguity(error, document, context));
    else if (error.keyword === "oneOf" || error.keyword === "anyOf") {
      const best = closestBranch(error);
      const level = {
        at: humanPath(error.instancePath, document), schemaPath: `${error.schemaPath}`, chosen: best.label, count: error.branches.length,
        alternatives: error.branches.filter(item => item !== best).map(item => ({ label: item.label, reason: reasonFor(item, document) }))
      };
      diagnostics.push(...schemaDiagnostics(best.errors, document, [...context, level]));
    } else diagnostics.push(describe(error, document, context));
  }
  return diagnostics;
}

function semanticDiagnostics(document) {
  const diagnostics = [];
  if (object(document) && !Object.hasOwn(document, "graph") && !Object.hasOwn(document, "graphs")) {
    diagnostics.push({
      severity: "info", category: "semantics", code: "no-graphs", path: "", title: "Document contains no graphs",
      message: 'Neither "graph" nor "graphs" is present. The schema accepts this as an empty multi-graph document, but there is nothing to preview.',
      hint: 'Add "graph": { "nodes": { … }, "edges": [ … ] }.', addGraph: true
    });
  }
  for (const { graph, path } of getGraphs(document)) {
    if (!object(graph)) continue;
    const name = graph.label ? `graph ${quote(graph.label)}` : path === "/graph" ? "the graph" : `the graph at ${humanPath(path, document)}`;
    const nodes = object(graph.nodes) ? graph.nodes : {};
    const ids = Object.keys(nodes);
    const used = new Set();
    const edgeIds = new Map();
    const reference = (id, location, role, owner) => {
      if (typeof id !== "string") return;
      if (Object.hasOwn(nodes, id)) { used.add(id); return; }
      const suggestion = suggest(id, ids);
      diagnostics.push({
        severity: "error", category: "reference", code: "unknown-node", path: location,
        title: `Unknown node ${quote(id)}`,
        message: `The ${owner} at ${humanPath(location.replace(/\/(source|target|nodes)(\/\d+)?$/, ""), document)} uses ${quote(id)} as ${role}, but ${name} defines no node with that key. ${ids.length ? `Defined node IDs: ${ids.slice(0, 8).map(quote).join(", ")}${ids.length > 8 ? `, and ${ids.length - 8} more` : ""}.` : "The graph has no nodes."}`,
        expected: `a key of ${humanPath(pointer(path, "nodes"), document)}`, found: quote(id),
        hint: suggestion ? `Did you mean ${quote(suggestion)}? Node IDs are case-sensitive.` : `Add ${quote(id)}: {} to ${humanPath(pointer(path, "nodes"), document)}, or change this reference.`,
        suggestion, id, graphPath: path
      });
    };
    const trackId = (edge, location, owner) => {
      if (typeof edge.id !== "string") return;
      if (edgeIds.has(edge.id)) diagnostics.push({
        severity: "warning", category: "semantics", code: "duplicate-edge-id", path: `${location}/id`,
        title: `Duplicate ${owner} ID ${quote(edge.id)}`,
        message: `${quote(edge.id)} was first used at ${humanPath(edgeIds.get(edge.id), document)}. Tools that look up edges by ID will find only one of them.`,
        hint: "Give each edge a unique ID, or remove the id property."
      });
      else edgeIds.set(edge.id, location);
    };
    if (Array.isArray(graph.edges)) graph.edges.forEach((edge, index) => {
      if (!object(edge)) return;
      const location = `${path}/edges/${index}`;
      reference(edge.source, `${location}/source`, "its source", "edge");
      reference(edge.target, `${location}/target`, "its target", "edge");
      trackId(edge, location, "edge");
      if (typeof edge.directed === "boolean" && edge.directed !== (graph.directed ?? true)) diagnostics.push({
        severity: "info", category: "semantics", code: "direction-override", path: `${location}/directed`,
        title: `Edge overrides the graph direction`,
        message: `This edge sets "directed": ${edge.directed}, while ${name} defaults to "directed": ${graph.directed ?? true}${graph.directed === undefined ? " (the schema default)" : ""}. The edge value applies to this edge only.`
      });
    });
    if (Array.isArray(graph.hyperedges)) graph.hyperedges.forEach((edge, index) => {
      if (!object(edge)) return;
      const location = `${path}/hyperedges/${index}`;
      for (const role of ["nodes", "source", "target"]) {
        if (!Array.isArray(edge[role])) continue;
        if (!edge[role].length) diagnostics.push({
          severity: "warning", category: "semantics", code: "empty-hyperedge", path: `${location}/${role}`,
          title: `Hyperedge has an empty ${quote(role)} array`,
          message: `The hyperedge at ${humanPath(location, document)} connects no nodes through ${quote(role)}.`
        });
        const seen = new Set();
        edge[role].forEach((id, memberIndex) => {
          reference(id, `${location}/${role}/${memberIndex}`, `a member of its ${quote(role)} array`, "hyperedge");
          if (seen.has(id)) diagnostics.push({
            severity: "info", category: "semantics", code: "duplicate-member", path: `${location}/${role}/${memberIndex}`,
            title: `Node ${quote(id)} is listed twice`, message: `The ${quote(role)} array of this hyperedge already contains ${quote(id)}.`
          });
          seen.add(id);
        });
      }
      trackId(edge, location, "hyperedge");
    });
    const isolated = ids.filter(id => !used.has(id));
    if (ids.length > 1 && isolated.length) diagnostics.push({
      severity: "info", category: "semantics", code: "isolated-nodes", path: pointer(path, "nodes"),
      title: `${isolated.length} ${isolated.length === 1 ? "node has" : "nodes have"} no connections`,
      message: `In ${name}: ${isolated.slice(0, 10).map(quote).join(", ")}${isolated.length > 10 ? `, and ${isolated.length - 10} more` : ""}. This is valid, but may indicate a missing edge or a mistyped reference.`
    });
  }
  return diagnostics;
}

export function validateDocument(document) {
  const errors = validateSchema(document);
  return [...schemaDiagnostics(errors, document), ...semanticDiagnostics(document)];
}

// JSON is parsed first; this token walk only indexes source ranges and duplicate keys.
function sourceLocations(source) {
  const locations = new Map();
  const duplicates = [];
  const stack = [];
  const tokens = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]:,]/g;
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
      parent.keyStart = start;
      parent.expectKey = false;
      if (parent.keys.has(parent.key)) duplicates.push({
        severity: "error", category: "duplicate-key", code: "duplicate-key", path: pointer(parent.path, parent.key), start, end: start + token.length,
        title: `Duplicate key ${quote(parent.key)}`,
        message: `${quote(parent.key)} appears more than once in the same object. JSON.parse keeps only the last value, so earlier data is silently discarded.`,
        hint: "Rename or merge the duplicate. Formatting is disabled until this is fixed, to avoid losing data."
      });
      parent.keys.add(parent.key);
      continue;
    }
    const path = parent ? pointer(parent.path, parent.type === "array" ? parent.index : parent.key) : "";
    locations.set(path, { start, end: start + token.length, keyStart: parent?.type === "object" ? parent.keyStart : undefined });
    if (token === "{" || token === "[") stack.push({ path, type: token === "{" ? "object" : "array", index: 0, key: "", expectKey: true, keys: new Set() });
  }
  return { locations, duplicates };
}

// V8 omits the position for some errors ("Unexpected token 'N', …"), so locate the first fault ourselves.
function syntaxErrorPosition(source) {
  let i = 0;
  const fail = () => { throw i; };
  const space = () => { while (i < source.length && " \t\n\r".includes(source[i])) i++; };
  const string = () => {
    i++;
    while (i < source.length && source[i] !== '"') {
      if (source[i] === "\\") {
        i++;
        if (source[i] === "u") { if (!/^[0-9a-fA-F]{4}$/.test(source.slice(i + 1, i + 5))) fail(); i += 4; }
        else if (!'"\\/bfnrt'.includes(source[i] ?? "x")) fail();
      } else if (source.charCodeAt(i) < 32) fail();
      i++;
    }
    if (i >= source.length) fail();
    i++;
  };
  const value = () => {
    space();
    const char = source[i];
    if (char === "{") {
      i++; space();
      if (source[i] === "}") { i++; return; }
      for (;;) {
        space();
        if (source[i] !== '"') fail();
        string(); space();
        if (source[i] !== ":") fail();
        i++; value(); space();
        if (source[i] === ",") { i++; continue; }
        if (source[i] === "}") { i++; return; }
        fail();
      }
    }
    if (char === "[") {
      i++; space();
      if (source[i] === "]") { i++; return; }
      for (;;) {
        value(); space();
        if (source[i] === ",") { i++; continue; }
        if (source[i] === "]") { i++; return; }
        fail();
      }
    }
    if (char === '"') return string();
    const literal = source.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!literal) fail();
    i += literal[0].length;
  };
  try {
    value(); space();
    return i < source.length ? i : null;
  } catch (position) {
    return position;
  }
}

function syntaxDiagnostic(source, error) {
  let start = Number(error.message.match(/position (\d+)/)?.[1] ?? syntaxErrorPosition(source) ?? source.length);
  const lineColumn = error.message.match(/line (\d+) column (\d+)/);
  if (lineColumn) start = source.split("\n").slice(0, Number(lineColumn[1]) - 1).reduce((length, line) => length + line.length + 1, 0) + Number(lineColumn[2]) - 1;
  const char = source[start];
  const before = source.slice(0, start).trimEnd().at(-1);
  let hint = "Check the character at the highlighted position and the line before it.";
  let repair = null;
  if ((char === "}" || char === "]") && before === ",") {
    hint = "Remove the trailing comma before this bracket. JSON does not allow trailing commas.";
    const comma = source.slice(0, start).lastIndexOf(",");
    repair = { label: "Remove trailing comma", edits: [{ from: comma, to: comma + 1, insert: "" }] };
  }
  else if (char === "'") hint = "JSON strings and property names must use double quotes (\"), not single quotes.";
  else if (char === "/") hint = "JSON does not allow comments. Remove them, or move notes into a metadata property.";
  else if (char && /[A-Za-z_$]/.test(char) && (before === "{" || before === ",")) hint = "Property names must be double-quoted strings, for example \"label\": \"A\".";
  else if (/^(NaN|Infinity|undefined)/.test(source.slice(start))) {
    hint = "NaN, Infinity, and undefined are JavaScript values, not JSON. Use null, a number, or a string.";
    const word = source.slice(start).match(/^(NaN|Infinity|undefined)/)[0];
    repair = { label: `Replace ${word} with null`, edits: [{ from: start, to: start + word.length, insert: "null" }] };
  } else if (char === '"' && /["\d\]}el]$/.test(before ?? "")) {
    hint = "A comma is probably missing between the previous value and this one.";
    const end = source.slice(0, start).trimEnd().length;
    repair = { label: "Insert missing comma", edits: [{ from: end, to: end, insert: "," }] };
  }
  else if (start >= source.trimEnd().length) {
    const open = [];
    let unterminated = false;
    for (const [token] of source.matchAll(/"(?:\\.|[^"\\\n])*"?|[{}[\]]/g)) {
      if (token === "{" || token === "[") open.push(token);
      else if (token === "}" || token === "]") open.pop();
      else unterminated = token.length < 2 || !token.endsWith('"') || token.endsWith('\\"');
    }
    const closers = open.reverse().map(token => token === "{" ? "}" : "]");
    const end = source.trimEnd().length;
    if (unterminated) {
      hint = `A string is never closed: add a closing double quote (")${open.length ? `, then ${closers.join(" ")}` : ""}.`;
      repair = { label: "Close the string" + (open.length ? " and brackets" : ""), edits: [{ from: end, to: end, insert: `"${closers.map(closer => `\n${closer}`).join("")}` }] };
    } else if (open.length) {
      hint = `The document ends with ${open.length} unclosed ${open.length === 1 ? "bracket" : "brackets"}: add ${closers.join(" ")}.`;
      repair = { label: `Close ${open.length} ${open.length === 1 ? "bracket" : "brackets"}`, edits: [{ from: end, to: end, insert: closers.map(closer => `\n${closer}`).join("") }] };
    } else hint = source.trim() ? "The document ends unexpectedly." : "The document is empty. Paste a JSON Graph document, open a file, or load the example.";
  }
  return {
    severity: "error", category: "syntax", code: "syntax", path: "", start, end: Math.min(start + 1, source.length),
    title: "JSON syntax error", message: `${error.message}. Nothing can be validated against the schema until the JSON parses.`,
    found: char === undefined ? "end of document" : JSON.stringify(char), hint, fixes: repair ? [repair] : []
  };
}

function place(diagnostic, source, locations) {
  if (diagnostic.start === undefined) {
    let path = diagnostic.path;
    let location = locations.get(path);
    while (!location && path) {
      path = path.slice(0, path.lastIndexOf("/"));
      location = locations.get(path);
    }
    diagnostic.start = location?.keyStart ?? location?.start ?? 0;
    diagnostic.end = location?.end ?? diagnostic.start;
  }
  const lineStart = source.lastIndexOf("\n", diagnostic.start - 1) + 1;
  const lineEnd = source.indexOf("\n", diagnostic.start);
  diagnostic.line = source.slice(0, diagnostic.start).split("\n").length;
  diagnostic.column = diagnostic.start - lineStart + 1;
  diagnostic.length = Math.max(1, Math.min(diagnostic.end, lineEnd === -1 ? source.length : lineEnd) - diagnostic.start);
  return diagnostic;
}

// ---- Quick fixes: minimal text edits, so the user's formatting survives. ----
const lineIndentAt = (source, position) => source.slice(source.lastIndexOf("\n", position - 1) + 1).match(/^[ \t]*/)[0];
function insertMember(source, location, key, valueText) {
  if (!location || source[location.start] !== "{") return null;
  const inner = source.slice(location.start + 1, location.end - 1);
  const member = `${JSON.stringify(key)}: ${valueText}`;
  if (!inner.trim()) return [{ from: location.start + 1, to: location.end - 1, insert: inner.includes("\n") ? `\n${lineIndentAt(source, location.start)}  ${member}\n${lineIndentAt(source, location.start)}` : member }];
  const first = location.start + 1 + inner.search(/\S/);
  if (inner.slice(0, first - location.start - 1).includes("\n")) return [{ from: first, to: first, insert: `${member},\n${lineIndentAt(source, first)}` }];
  return [{ from: first, to: first, insert: `${member}, ` }];
}
function removeMember(source, location) {
  if (location?.keyStart === undefined) return null;
  let from = location.keyStart;
  let to = location.end;
  const after = to + source.slice(to).search(/\S|$/);
  if (source[after] === ",") to = after + 1;
  else {
    const previous = source.slice(0, from).trimEnd();
    if (previous.endsWith(",")) from = previous.length - 1;
  }
  const lineStart = source.lastIndexOf("\n", from - 1) + 1;
  const lineEnd = source.indexOf("\n", to);
  if (!source.slice(lineStart, from).trim() && !source.slice(to, lineEnd === -1 ? source.length : lineEnd).trim()) {
    from = lineStart;
    to = lineEnd === -1 ? source.length : lineEnd + 1;
  }
  return [{ from, to, insert: "" }];
}
function replaceValue(location, value) {
  return location ? [{ from: location.start, to: location.end, insert: JSON.stringify(value) }] : null;
}
function fixesFor(diagnostic, source, locations, document) {
  const fixes = [];
  const add = (label, edits) => { if (edits) fixes.push({ label, edits }); };
  switch (diagnostic.code) {
    case "schema-additional-property": {
      const location = locations.get(diagnostic.path);
      const parent = locations.get(diagnostic.objectPath);
      const siblings = new Set(Object.keys(valueAt(document, diagnostic.objectPath) ?? {}));
      const keyText = JSON.stringify(diagnostic.property);
      if (diagnostic.suggestion && !siblings.has(diagnostic.suggestion) && location?.keyStart !== undefined && source.startsWith(keyText, location.keyStart)) {
        add(`Rename to ${quote(diagnostic.suggestion)}`, [{ from: location.keyStart, to: location.keyStart + keyText.length, insert: JSON.stringify(diagnostic.suggestion) }]);
      }
      if (diagnostic.canMoveToMetadata && !siblings.has("metadata") && location && parent) {
        const removal = removeMember(source, location);
        const value = source.slice(location.start, location.end);
        const insertion = insertMember(source, parent, "metadata", `{ ${keyText}: ${value} }`);
        // Removal and insertion must not overlap; the insertion lands at the object's first member.
        if (removal && insertion && (insertion[0].from <= removal[0].from || insertion[0].from >= removal[0].to)) add(`Move ${quote(diagnostic.property)} into "metadata"`, [...insertion, ...removal]);
      }
      add(`Remove ${quote(diagnostic.property)}`, removeMember(source, location));
      break;
    }
    case "unknown-node": {
      const location = locations.get(diagnostic.path);
      if (diagnostic.suggestion) add(`Change to ${quote(diagnostic.suggestion)}`, replaceValue(location, diagnostic.suggestion));
      const graph = valueAt(document, diagnostic.graphPath);
      if (object(graph?.nodes)) add(`Add node ${quote(diagnostic.id)}`, insertMember(source, locations.get(pointer(diagnostic.graphPath, "nodes")), diagnostic.id, "{}"));
      else if (object(graph) && !Object.hasOwn(graph, "nodes")) add(`Add node ${quote(diagnostic.id)}`, insertMember(source, locations.get(diagnostic.graphPath), "nodes", `{ ${JSON.stringify(diagnostic.id)}: {} }`));
      break;
    }
    case "schema-ambiguous-oneof":
      if (diagnostic.addEdges) add('Add "edges": []', insertMember(source, locations.get(diagnostic.path), "edges", "[]"));
      break;
    case "schema-required":
      if (diagnostic.property === "directed") add('Add "directed": false', insertMember(source, locations.get(diagnostic.objectPath), "directed", "false"));
      break;
    case "schema-type": {
      const location = locations.get(diagnostic.path);
      const { expectedTypes: expected, value } = diagnostic;
      if (expected?.includes("boolean") && (value === "true" || value === "false")) add(`Use ${value} without quotes`, replaceValue(location, value === "true"));
      else if (expected?.includes("string") && typeof value === "number") add(`Use the string "${value}"`, replaceValue(location, String(value)));
      else if (expected?.includes("object") && Array.isArray(value) && diagnostic.path.endsWith("/nodes")) {
        const converted = convertV1(document);
        if (converted.changed) add("Convert document from JSON Graph v1 to v2", [{ from: 0, to: source.length, insert: JSON.stringify(converted.document, null, 2) }]);
      }
      break;
    }
    case "no-graphs":
      if (diagnostic.addGraph) add("Add an empty graph", insertMember(source, locations.get(""), "graph", '{ "nodes": {}, "edges": [] }'));
      break;
  }
  return fixes;
}
function valueAt(document, path) {
  let value = document;
  for (const key of segments(path ?? "")) value = value?.[key];
  return value;
}

/** Applies non-overlapping edits (positions refer to the original text). */
export function applyEdits(text, edits) {
  return [...edits].sort((a, b) => b.from - a.from).reduce((result, edit) => result.slice(0, edit.from) + edit.insert + result.slice(edit.to), text);
}

const V2_FIELDS = {
  graph: new Set(Object.keys(schema.definitions.graph.oneOf[0].properties)),
  node: new Set(Object.keys(schema.definitions.node.properties)),
  edge: new Set(Object.keys(schema.definitions.edge.properties))
};
function moveExtrasToMetadata(item, allowed, where, notes) {
  if (!object(item)) return item;
  const result = {};
  const extras = {};
  for (const [key, value] of Object.entries(item)) (allowed.has(key) ? result : extras)[key] = value;
  const moved = Object.keys(extras);
  if (moved.length) {
    result.metadata = object(result.metadata) ? { ...extras, ...result.metadata } : result.metadata === undefined ? extras : { ...extras, value: result.metadata };
    notes.push(`${where}: moved ${list(moved.map(quote), "and")} into "metadata".`);
  }
  return result;
}
/**
 * Converts JSON Graph v1 (nodes as an array of { id, … }) to v2 (nodes keyed by ID).
 * Returns { document, changed, notes }; the input is not modified.
 */
export function convertV1(input) {
  const notes = [];
  const document = structuredClone(input);
  let changed = false;
  const convertGraph = (graph, where) => {
    if (!object(graph) || !Array.isArray(graph.nodes)) return graph;
    changed = true;
    const nodes = {};
    graph.nodes.forEach((node, index) => {
      if (!object(node)) { notes.push(`${where} node ${index + 1} is not an object and was dropped.`); return; }
      let id = node.id === undefined ? null : String(node.id);
      if (id === null) { id = `node-${index + 1}`; notes.push(`${where} node ${index + 1} had no "id"; it is now ${quote(id)}.`); }
      if (Object.hasOwn(nodes, id)) { notes.push(`${where} node ${quote(id)} appears more than once; later copies were dropped.`); return; }
      const { id: _, ...rest } = node;
      nodes[id] = moveExtrasToMetadata(rest, V2_FIELDS.node, `${where} node ${quote(id)}`, notes);
    });
    const result = moveExtrasToMetadata({ ...graph, nodes }, V2_FIELDS.graph, where, notes);
    if (Array.isArray(result.edges)) result.edges = result.edges.map((edge, index) => {
      const converted = moveExtrasToMetadata(edge, V2_FIELDS.edge, `${where} edge ${index + 1}`, notes);
      for (const end of ["source", "target"]) if (typeof converted?.[end] === "number") converted[end] = String(converted[end]);
      return converted;
    });
    notes.unshift(`${where}: converted ${graph.nodes.length} nodes from an array to an object keyed by ID.`);
    return result;
  };
  if (object(document)) {
    if (object(document.graph)) document.graph = convertGraph(document.graph, "graph");
    if (Array.isArray(document.graphs)) document.graphs = document.graphs.map((graph, index) => convertGraph(graph, `graphs[${index}]`));
  }
  return { document, changed, notes };
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

export function analyzeSource(source) {
  const started = performance.now();
  const summary = { schema: "not-run", strictValid: false, graphs: 0, nodes: 0, links: 0 };
  if (new TextEncoder().encode(source).length > MAX_SOURCE_BYTES) {
    return { document: null, locations: new Map(), summary, diagnostics: [place({
      severity: "error", category: "syntax", code: "too-large", path: "", start: 0, end: 0,
      title: "Document is too large", message: `The workbench accepts up to ${MAX_SOURCE_BYTES / 1024 / 1024} MiB to keep validation and layout responsive in the browser.`,
      hint: "Split the document into smaller files, or remove large metadata."
    }, source, new Map())] };
  }
  let document;
  try {
    document = JSON.parse(source);
  } catch (error) {
    summary.ms = performance.now() - started;
    return { document: null, locations: new Map(), summary, diagnostics: [place(syntaxDiagnostic(source, error), source, new Map())] };
  }
  const { locations, duplicates } = sourceLocations(source);
  const errors = validateSchema(document);
  summary.strictValid = errors.length === 0;
  summary.schema = errors.some(error => !error.ambiguous) ? "invalid" : errors.length ? "ambiguous" : "valid";
  const schemaFindings = schemaDiagnostics(errors, document);
  summary.schemaErrors = schemaFindings.filter(item => item.severity === "error").length;
  const diagnostics = [...duplicates, ...schemaFindings, ...semanticDiagnostics(document)]
    .map(item => place(item, source, locations))
    .map(item => ({ ...item, fixes: fixesFor(item, source, locations, document) }))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.start - b.start);
  for (const { graph } of getGraphs(document)) {
    if (!object(graph)) continue;
    summary.graphs++;
    if (object(graph.nodes)) summary.nodes += Object.keys(graph.nodes).length;
    summary.links += (Array.isArray(graph.edges) ? graph.edges.length : 0) + (Array.isArray(graph.hyperedges) ? graph.hyperedges.length : 0);
  }
  summary.ms = performance.now() - started;
  return { document, locations, diagnostics, summary };
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

/**
 * Graphviz sizes labels to their text but never wraps it, so long labels are broken into lines here.
 * Words longer than the width are split, preferably after punctuation; after maxLines the label ends with an ellipsis.
 */
export function wrapLabel(value, width = 22, maxLines = 5) {
  const lines = [];
  for (const paragraph of String(value).split(/\r?\n/)) {
    let line = "";
    for (let word of paragraph.split(/\s+/).filter(Boolean)) {
      while (word.length > width) {
        if (line) { lines.push(line); line = ""; }
        // Prefer breaking a long URL or identifier after punctuation; never insert characters that are not in the label.
        const cut = Math.max(...[..."/.-_?&=:"].map(char => word.lastIndexOf(char, width - 1) + 1));
        const at = cut > width / 3 ? cut : width;
        lines.push(word.slice(0, at));
        word = word.slice(at);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, width - 1)}…`;
  }
  return lines.join("\n");
}
function dotString(value) {
  return JSON.stringify(String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""));
}

const STRUCTURAL = { node: new Set(["label"]), edge: new Set(["source", "target", "nodes", "label"]) };
const MAX_ATTRIBUTES = 60;
/** Reads a dotted attribute path such as "metadata.type". "id" on a node is its key in the nodes object. */
export function attributeValue(item, path, id) {
  if (path === "id" && id !== undefined) return id;
  let value = item;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}
/** Lists the scalar attribute paths used by a graph's nodes and edges, most common first. */
export function attributePaths(graph) {
  const collect = (items, kind) => {
    const counts = new Map();
    const walk = (value, prefix, depth) => {
      for (const [key, child] of Object.entries(value)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (!prefix && STRUCTURAL[kind].has(key)) continue;
        if (child !== null && typeof child === "object" && !Array.isArray(child)) { if (depth < 3) walk(child, path, depth + 1); }
        else counts.set(path, (counts.get(path) ?? 0) + 1);
      }
    };
    for (const item of items) if (item && typeof item === "object") walk(item, "", 0);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_ATTRIBUTES).map(([path]) => path);
  };
  const nodes = Object.values(graph?.nodes ?? {});
  return { node: nodes.length ? ["id", ...collect(nodes, "node")] : [], edge: collect(graph?.edges ?? graph?.hyperedges ?? [], "edge") };
}
const attributeText = value => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
};
const htmlEscape = text => String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/[&<>"]/g, char => `&#${char.charCodeAt(0)};`);
// Graphviz HTML-like label: the label, then each attribute on its own smaller line.
function richLabel(title, item, paths, id, width, lines, size, color) {
  const extra = paths.map(path => [path, attributeValue(item, path, id)]).filter(([, value]) => value !== undefined);
  if (!extra.length) return title === undefined ? null : dotString(wrapLabel(title, width, lines));
  const rows = title === undefined ? [] : [wrapLabel(title, width, lines).split("\n").map(htmlEscape).join("<BR/>")];
  for (const [path, value] of extra) rows.push(`<FONT POINT-SIZE="${size}" COLOR="${color}">${htmlEscape(`${path}: ${attributeText(value)}`)}</FONT>`);
  return `<${rows.join("<BR/>")}>`;
}

export const LIGHT_GRAPH_COLORS = { node: "#ffffff", border: "#a6b8d0", text: "#233346", edge: "#8da1bc", edgeText: "#526781", junction: "#dce7f7" };

/**
 * Converts one JSON Graph graph to Graphviz DOT.
 * compact: dots without labels for large graphs (paired with the sfdp engine).
 */
export function toDot(graph, { labels = true, compact = false, colors = LIGHT_GRAPH_COLORS, attributes = {} } = {}) {
  const nodeAttributes = compact ? [] : attributes.node ?? [];
  const edgeAttributes = compact || !labels ? [] : attributes.edge ?? [];
  const ids = new Map(Object.keys(graph.nodes ?? {}).map((id, index) => [id, `n${index}`]));
  const showLabels = labels && !compact;
  const lines = compact ? [
    "digraph G {",
    'graph [bgcolor="transparent", pad="0.35", overlap="true", splines="false", outputorder="edgesfirst"];',
    `node [shape="circle", style="filled", fillcolor="${colors.junction}", color="${colors.border}", label="", width="0.14", height="0.14", fixedsize="true", penwidth="0.8"];`,
    `edge [color="${colors.edge}", arrowsize="0.35", penwidth="0.6"];`
  ] : [
    "digraph G {",
    'graph [bgcolor="transparent", rankdir="TB", pad="0.35", nodesep="0.45", ranksep="0.6", overlap="false", splines="true", outputorder="edgesfirst"];',
    `node [shape="box", style="rounded,filled", fillcolor="${colors.node}", color="${colors.border}", fontcolor="${colors.text}", fontname="Helvetica", fontsize="12", margin="0.18,0.12", penwidth="1.2"];`,
    `edge [color="${colors.edge}", fontcolor="${colors.edgeText}", fontname="Helvetica", fontsize="10", arrowsize="0.65"];`
  ];
  for (const [id, node] of Object.entries(graph.nodes ?? {})) {
    lines.push(compact ? `${ids.get(id)} [id="${ids.get(id)}"];` : `${ids.get(id)} [id="${ids.get(id)}", label=${richLabel(node?.label ?? id, node, nodeAttributes, id, 22, 5, 10, colors.edgeText)}];`);
  }
  const edgeLabel = edge => showLabels ? richLabel(edge.label ?? edge.relation, edge, edgeAttributes, undefined, 18, 3, 9, colors.edgeText) : null;
  const edgeDot = (edge, index, directed) => {
    const label = edgeLabel(edge);
    return `id="e${index}", dir="${directed ? "forward" : "none"}"${label ? `, label=${label}` : ""}`;
  };
  if (graph.edges) graph.edges.forEach((edge, index) => {
    lines.push(`${ids.get(edge.source)} -> ${ids.get(edge.target)} [${edgeDot(edge, index, edge.directed ?? graph.directed ?? true)}];`);
  });
  if (graph.hyperedges) graph.hyperedges.forEach((edge, index) => {
    const directed = !Array.isArray(edge.nodes);
    lines.push(`h${index} [id="h${index}", shape="diamond", width="${compact ? 0.12 : 0.18}", height="${compact ? 0.12 : 0.18}", margin="0", label="", style="filled", fillcolor="${colors.junction}"];`);
    const sources = directed ? edge.source : edge.nodes;
    for (const [memberIndex, id] of sources.entries()) lines.push(`${ids.get(id)} -> h${index} [id="e${index}s${memberIndex}", dir="none"];`);
    if (directed) for (const [memberIndex, id] of edge.target.entries()) lines.push(`h${index} -> ${ids.get(id)} [id="e${index}t${memberIndex}"];`);
    const label = edgeLabel(edge);
    if (label) lines.push(`h${index} [xlabel=${label}];`);
  });
  return `${lines.join("\n")}\n}`;
}

/** "full": normal preview, "compact": dots-only large-graph preview, "too-large": statistics only. */
export function previewMode(graph) {
  const size = layoutSize(graph);
  if (size.nodes <= MAX_LAYOUT_NODES && size.links <= MAX_LAYOUT_LINKS) return { mode: "full", ...size };
  if (size.nodes <= MAX_COMPACT_NODES && size.links <= MAX_COMPACT_LINKS) return { mode: "compact", ...size };
  return { mode: "too-large", ...size };
}

export function layoutSize(graph) {
  return {
    nodes: Object.keys(graph.nodes ?? {}).length + (graph.hyperedges?.length ?? 0),
    links: graph.edges?.length ?? graph.hyperedges?.reduce((total, edge) => total + (edge.nodes?.length ?? edge.source.length + edge.target.length), 0) ?? 0
  };
}

const linkKey = (edge, hyper) => JSON.stringify(hyper ? [edge.nodes ?? null, edge.source ?? null, edge.target ?? null, edge.relation ?? null] : [edge.source, edge.target, edge.relation ?? null]);
/**
 * Compares two graphs. Nodes match by ID; edges match by source, target and relation (hyperedges by their member lists).
 * Returns { nodes, links } where each has added and changed (node IDs or link indexes in `after`) and removed (descriptions).
 */
export function diffGraphs(before, after) {
  const result = { nodes: { added: new Set(), changed: new Set(), removed: [] }, links: { added: new Set(), changed: new Set(), removed: [] } };
  const oldNodes = before?.nodes ?? {};
  const newNodes = after?.nodes ?? {};
  for (const [id, node] of Object.entries(newNodes)) {
    if (!Object.hasOwn(oldNodes, id)) result.nodes.added.add(id);
    else if (JSON.stringify(oldNodes[id]) !== JSON.stringify(node)) result.nodes.changed.add(id);
  }
  for (const [id, node] of Object.entries(oldNodes)) if (!Object.hasOwn(newNodes, id)) result.nodes.removed.push(node?.label ? `${node.label} (${id})` : id);
  const hyper = Boolean(after?.hyperedges);
  const oldLinks = new Map();
  for (const edge of (hyper ? before?.hyperedges : before?.edges) ?? []) {
    const key = linkKey(edge, hyper);
    oldLinks.set(key, [...(oldLinks.get(key) ?? []), edge]);
  }
  ((hyper ? after?.hyperedges : after?.edges) ?? []).forEach((edge, index) => {
    const matches = oldLinks.get(linkKey(edge, hyper));
    if (!matches?.length) { result.links.added.add(index); return; }
    const same = matches.findIndex(old => JSON.stringify(old) === JSON.stringify(edge));
    if (same < 0) result.links.changed.add(index);
    matches.splice(Math.max(0, same), 1);
  });
  for (const edges of oldLinks.values()) for (const edge of edges) {
    result.links.removed.push(edge.label ?? edge.relation ?? (hyper ? "hyperedge" : `${edge.source} → ${edge.target}`));
  }
  return result;
}
