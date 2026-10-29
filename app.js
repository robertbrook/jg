import { analyzeSource, applyEdits, getGraphs, graphStats, humanPath, previewMode, toDot, pointer, SCHEMA, MAX_SOURCE_BYTES, MAX_LAYOUT_NODES, MAX_LAYOUT_LINKS, MAX_COMPACT_NODES, MAX_COMPACT_LINKS } from "./graph.js";
import { createEditor } from "./vendor/editor.js";
import { example } from "./example.js";

const $ = id => document.getElementById(id);
let analysis;
let analyzedText = "";
let entries = [];
let current = 0;
let selection = null;
let worker;
let ready = false;
let pending = false;
let job = 0;
let workerTimer;
let editTimer;
let svg = null;
let baseView = null;
let view = null;
let lastLoaded = "";
let filename = "example.json";
let suppressClick = false;
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const active = () => entries[current];
const hasErrors = () => analysis?.diagnostics.some(item => item.severity === "error");
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const button = (text, action, className) => {
  const node = element("button", text, className);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
};
const status = message => { $("status").textContent = message; };

const STORAGE_KEY = `jg:document:${location.pathname}`;
const SETTINGS_KEY = "jg:settings";
let saveTimer;
let cursorTimer;
const editor = createEditor($("editor"), {
  label: "JSON Graph document",
  onChange: documentEdited,
  onCursor: (info, byUser) => {
    $("cursor").textContent = `Ln ${info.line}, Col ${info.column}`;
    clearTimeout(cursorTimer);
    if (byUser) cursorTimer = setTimeout(() => selectFromSource(info.position), 120);
  },
  onRun: () => update(),
  onFormat: () => format(),
  onFix: fix => applyFix(fix)
});
function jumpTo(path, start, length = 0) {
  let location = analysis?.locations.get(path);
  while (!location && path) {
    path = path.slice(0, path.lastIndexOf("/"));
    location = analysis?.locations.get(path);
  }
  const from = start ?? location?.keyStart ?? location?.start ?? 0;
  const to = start === undefined ? location?.end ?? from : from + Math.max(1, length);
  editor.select(from, to);
}
const SEVERITY_LABEL = { error: "Error", warning: "Warning", info: "Info" };
const MAX_RENDERED_DIAGNOSTICS = 200;
let diagnosticFilter = "all";
const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const severityCounts = () => {
  const counts = { all: analysis.diagnostics.length, error: 0, warning: 0, info: 0 };
  for (const item of analysis.diagnostics) counts[item.severity]++;
  return counts;
};
function schemaState() {
  const { summary } = analysis;
  if (summary.schema === "not-run") return ["state-invalid", "Not run — the JSON must parse first"];
  if (summary.schema === "valid") return ["state-valid", "Valid"];
  if (summary.schema === "ambiguous") return ["state-ambiguous", "Accepted here; strict draft-07 validators reject (ambiguous oneOf)"];
  return ["state-invalid", `Invalid · ${plural(summary.schemaErrors, "violation")}`];
}
function excerpt(diagnostic) {
  if (!diagnostic.line) return null;
  const lines = analyzedText.split("\n");
  const index = diagnostic.line - 1;
  if (index >= lines.length) return null;
  const width = String(Math.min(lines.length, index + 2)).length;
  const column = Math.max(0, (diagnostic.column ?? 1) - 1);
  // Keep very long lines readable by windowing around the column.
  const offset = Math.max(0, Math.min(column - 30, lines[index].length - 90));
  const clip = text => {
    const slice = text.slice(offset, offset + 100);
    return (offset ? "…" : "") + slice + (text.length > offset + 100 ? "…" : "");
  };
  const block = element("pre", undefined, "excerpt");
  if (index > 0) block.append(`${String(index).padStart(width)} │ ${clip(lines[index - 1])}\n`);
  block.append(`${String(index + 1).padStart(width)} │ ${clip(lines[index])}\n`);
  const span = Math.max(1, Math.min(diagnostic.length || 1, lines[index].length - column || 1, 60));
  block.append(element("span", `${" ".repeat(width)} │ ${" ".repeat(column - offset + (offset ? 1 : 0))}${"^".repeat(span)}`, "caret"));
  if (index + 1 < lines.length) block.append(`\n${String(index + 2).padStart(width)} │ ${clip(lines[index + 1])}`);
  return block;
}
function detailRows(diagnostic) {
  return [
    ["Expected", diagnostic.expected],
    ["Found", diagnostic.found],
    ["Path", diagnostic.path !== undefined ? humanPath(diagnostic.path, analysis.document) : undefined],
    ["JSON pointer", diagnostic.path !== undefined ? diagnostic.path || "(root)" : undefined],
    ["Schema rule", diagnostic.schemaPath],
    ["Code", diagnostic.code]
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
}
function renderDiagnostic(diagnostic) {
  const item = element("article", undefined, `diagnostic ${diagnostic.severity}`);
  const head = element("div", undefined, "diagnostic-head");
  head.append(element("span", SEVERITY_LABEL[diagnostic.severity], "badge"), element("span", [diagnostic.category, diagnostic.keyword].filter(Boolean).join(" · "), "diagnostic-meta"));
  const title = button(diagnostic.title ?? diagnostic.message, () => jumpTo(diagnostic.path, diagnostic.start, diagnostic.length), "diagnostic-title");
  title.title = "Jump to this location in the document";
  if (diagnostic.line) title.append(element("span", `Ln ${diagnostic.line}, Col ${diagnostic.column}`, "position"));
  item.append(head, title);
  if (diagnostic.title && diagnostic.message) item.append(element("p", diagnostic.message));
  if (diagnostic.hint) {
    const hint = element("p", undefined, "hint");
    hint.append(element("strong", "Fix: "), diagnostic.hint);
    item.append(hint);
  }
  if (diagnostic.fixes?.length) {
    const actions = element("div", undefined, "fix-actions");
    for (const fix of diagnostic.fixes) actions.append(button(fix.label, () => applyFix(fix), "fix"));
    item.append(actions);
  }
  const rows = detailRows(diagnostic);
  if (rows.length) {
    const list = element("dl", undefined, "diagnostic-details");
    for (const [term, value] of rows) list.append(element("dt", term), element("dd", value));
    item.append(list);
  }
  for (const step of diagnostic.context ?? []) {
    const box = element("div", undefined, "diagnostic-context");
    box.append(element("p", `At ${step.at}, the schema offers ${step.count} alternatives (oneOf). Checked against the closest: ${step.chosen}.`));
    if (step.alternatives?.length) {
      const others = element("ul");
      for (const alternative of step.alternatives) others.append(element("li", `${alternative.label} — ${alternative.reason}`));
      box.append(others);
    }
    item.append(box);
  }
  const snippet = excerpt(diagnostic);
  if (snippet) item.append(snippet);
  return item;
}
function showDiagnostics() {
  const list = $("diagnostics");
  const counts = severityCounts();
  const { summary } = analysis;
  $("diagnostic-count").textContent = counts.all ? [plural(counts.error, "error"), plural(counts.warning, "warning"), counts.info ? `${counts.info} info` : ""].filter(Boolean).join(" · ") : "No issues";
  for (const control of document.querySelectorAll("[data-filter]")) {
    control.querySelector("span").textContent = counts[control.dataset.filter];
    control.setAttribute("aria-pressed", String(control.dataset.filter === diagnosticFilter));
  }
  const [stateClass, stateText] = schemaState();
  const summaryList = element("dl", undefined, "diagnostic-summary");
  summaryList.replaceChildren(
    element("dt", "Schema"), element("dd", [SCHEMA.file, SCHEMA.dialect, SCHEMA.id].filter(Boolean).join(" · ")),
    element("dt", "Result"), element("dd", stateText, stateClass),
    element("dt", "Contents"), element("dd", `${plural(summary.graphs, "graph")} · ${plural(summary.nodes, "node")} · ${plural(summary.links, "edge or hyperedge", "edges and hyperedges")}`),
    element("dt", "Checks"), element("dd", `Syntax, duplicate keys, schema, node references, and graph semantics · ${summary.ms.toFixed(1)} ms`)
  );
  $("diagnostic-summary").replaceWith(summaryList);
  summaryList.id = "diagnostic-summary";
  list.classList.toggle("compact", !$("diagnostic-details").checked);
  list.replaceChildren();
  if (!counts.all) {
    const healthy = element("div", "All checks passed", "healthy");
    healthy.append(element("small", "The document is valid JSON Graph v2: it matches the official schema, has no duplicate keys, and every edge and hyperedge references a defined node."));
    list.append(healthy);
    return;
  }
  const shown = analysis.diagnostics.filter(item => diagnosticFilter === "all" || item.severity === diagnosticFilter);
  if (!shown.length) list.append(element("p", `No ${diagnosticFilter === "info" ? "info" : `${diagnosticFilter}s`} in this document.`, "diagnostics-more"));
  for (const diagnostic of shown.slice(0, MAX_RENDERED_DIAGNOSTICS)) list.append(renderDiagnostic(diagnostic));
  if (shown.length > MAX_RENDERED_DIAGNOSTICS) list.append(element("p", `Showing the first ${MAX_RENDERED_DIAGNOSTICS} of ${shown.length}. Copy the report to see all of them.`, "diagnostics-more"));
}
function diagnosticReport() {
  const counts = severityCounts();
  const lines = [
    `JSON Graph diagnostics — ${filename}`,
    `Schema: ${SCHEMA.file} (${SCHEMA.dialect}) — ${schemaState()[1]}`,
    `Totals: ${plural(counts.error, "error")}, ${plural(counts.warning, "warning")}, ${counts.info} info`,
    ""
  ];
  analysis.diagnostics.forEach((diagnostic, index) => {
    lines.push(`${index + 1}. [${SEVERITY_LABEL[diagnostic.severity]}] ${diagnostic.title ?? diagnostic.message}${diagnostic.line ? ` (Ln ${diagnostic.line}, Col ${diagnostic.column})` : ""}`);
    if (diagnostic.title && diagnostic.message) lines.push(`   ${diagnostic.message}`);
    for (const [term, value] of detailRows(diagnostic)) lines.push(`   ${term}: ${value}`);
    for (const step of diagnostic.context ?? []) {
      lines.push(`   oneOf at ${step.at}: closest is ${step.chosen}`);
      for (const alternative of step.alternatives ?? []) lines.push(`     – ${alternative.label}: ${alternative.reason}`);
    }
    if (diagnostic.hint) lines.push(`   Fix: ${diagnostic.hint}`);
    for (const fix of diagnostic.fixes ?? []) lines.push(`   Quick fix available: ${fix.label}`);
    lines.push("");
  });
  return lines.join("\n");
}
function clearCanvas(message) {
  svg = null;
  baseView = null;
  view = null;
  $("canvas").replaceChildren();
  $("preview-message").textContent = message;
  $("preview-message").hidden = !message;
  for (const id of ["zoom-in", "zoom-out", "fit", "export-svg", "export-png"]) $(id).disabled = true;
  $("zoom-level").textContent = "—";
}
function update() {
  clearTimeout(editTimer);
  job++;
  selection = null;
  analyzedText = editor.value;
  analysis = analyzeSource(analyzedText);
  editor.setDiagnostics(analysis.diagnostics.map(item => ({ from: item.start, to: item.start + item.length, severity: item.severity, message: [item.title, item.message, item.hint && `Fix: ${item.hint}`].filter(Boolean).join("\n"), fixes: item.fixes })));
  editor.link(null);
  entries = hasErrors() ? [] : getGraphs(analysis.document);
  current = Math.min(current, Math.max(0, entries.length - 1));
  $("graph-select").replaceChildren();
  entries.forEach(({ graph }, index) => {
    const option = element("option", graph.label || graph.id || `Graph ${index + 1}`);
    option.value = index;
    $("graph-select").append(option);
  });
  if (!entries.length) $("graph-select").append(element("option", hasErrors() ? "Invalid document" : "No graphs"));
  $("graph-select").value = String(current);
  $("graph-select").disabled = !entries.length;
  $("search").value = "";
  showDiagnostics();
  showInspector();
  $("export-dot").disabled = !active();
  search();
  if (hasErrors()) {
    clearCanvas("The document needs attention. Select a diagnostic to jump to its source.");
    $("graph-summary").textContent = "Preview paused · Fix document errors to continue";
    $("viewport").setAttribute("aria-busy", "false");
    status("Document has errors. Preview is not showing stale data.");
    return;
  }
  if (!active()) {
    clearCanvas("No graphs in this document. Add a graph to the graphs array.");
    $("graph-summary").textContent = "0 graphs";
    $("viewport").setAttribute("aria-busy", "false");
    status("Valid document · No graphs");
    return;
  }
  render();
}
function engineFailure(message) {
  clearTimeout(workerTimer);
  worker?.terminate();
  ready = false;
  pending = false;
  $("engine-status").textContent = "Layout unavailable";
  $("retry-engine").hidden = false;
  clearCanvas(message);
  $("viewport").setAttribute("aria-busy", "false");
  status(message);
}
function startWorker() {
  worker?.terminate();
  clearTimeout(workerTimer);
  ready = false;
  pending = false;
  $("retry-engine").hidden = true;
  $("engine-status").textContent = "Starting WASM…";
  try {
    worker = new Worker(new URL("./layout-worker.js", import.meta.url), { type: "module" });
  } catch (error) {
    engineFailure(`Cannot start the layout worker: ${error.message}. Serve this page over HTTP, then retry.`);
    return;
  }
  workerTimer = setTimeout(() => engineFailure("The WASM engine took too long to start. Retry the layout engine."), 15000);
  worker.onerror = event => {
    event.preventDefault();
    engineFailure(`Layout worker failed: ${event.message || "could not load the WASM bundle"}. Retry the layout engine.`);
  };
  worker.onmessage = ({ data }) => {
    if (data.type === "init-error") { engineFailure(`Cannot initialize WASM: ${data.message}. Retry the layout engine.`); return; }
    if (data.type === "ready") {
      clearTimeout(workerTimer);
      ready = true;
      $("engine-status").textContent = `Graphviz ${data.version} · WASM`;
      if (active() && !hasErrors()) render();
      return;
    }
    if (data.type !== "result") return;
    pending = false;
    clearTimeout(workerTimer);
    if (data.id !== job) return;
    $("viewport").setAttribute("aria-busy", "false");
    if (!data.success) {
      const message = (data.errors ?? []).map(error => error.message).join("; ");
      clearCanvas(`Layout failed: ${message || "Graphviz returned no output"}. Try a different layout.`);
      status("Layout failed. The document remains available in the editor.");
      return;
    }
    try {
      mountSVG(data.svg);
      // sfdp always reports the missing triangulation library in the WASM build; layout is unaffected.
      const warnings = data.errors?.map(error => error.message).filter(message => !message.includes("triangulation library")).join("; ");
      status(`Rendered in ${Math.round(data.duration)} ms${warnings ? ` · Graphviz: ${warnings}` : " · All processing stays in this browser"}`);
    } catch (error) {
      clearCanvas(`Cannot display the graph: ${error.message}`);
      status(`Preview failed: ${error.message}`);
    }
  };
}
function render() {
  if (!active() || hasErrors()) return;
  const { graph } = active();
  const stats = graphStats(graph);
  const size = previewMode(graph);
  $("graph-summary").textContent = `${stats.nodes} nodes · ${stats.links} ${graph.hyperedges ? "hyperedges" : "edges"} · ${stats.components} components · ${stats.isolated} isolated${size.mode === "compact" ? " · Large-graph mode: dots only, sfdp layout" : ""}`;
  showInspector();
  if (size.mode === "too-large") {
    clearCanvas(`This graph has ${size.nodes} layout nodes and ${size.links} connections. In-browser layout supports up to ${MAX_COMPACT_NODES} and ${MAX_COMPACT_LINKS}. Validation, search, the inspector, and DOT export still work.`);
    $("viewport").setAttribute("aria-busy", "false");
    status("Graph exceeds the in-browser layout limit.");
    return;
  }
  if (!stats.nodes) {
    clearCanvas("This graph has no nodes yet. Add entries to its nodes object.");
    $("viewport").setAttribute("aria-busy", "false");
    status("Valid graph · No nodes to render");
    return;
  }
  // The WASM engine is only fetched once there is something to draw.
  if (!worker) startWorker();
  clearCanvas(ready ? `Laying out ${size.mode === "compact" ? `${size.nodes} nodes in large-graph mode` : "the graph"}…` : "Starting the WASM layout engine…");
  $("viewport").setAttribute("aria-busy", "true");
  if (!ready) return;
  if (pending) { startWorker(); return; }
  const id = ++job;
  pending = true;
  const limit = size.mode === "compact" ? 30000 : 12000;
  workerTimer = setTimeout(() => engineFailure(`Layout exceeded ${limit / 1000} seconds. Choose a simpler graph or a different layout, then retry the engine.`), limit);
  worker.postMessage({ id, dot: currentDot(), engine: size.mode === "compact" ? "sfdp" : $("layout").value });
}
function currentDot() {
  const { graph } = active();
  return toDot(graph, { labels: $("labels").checked, compact: previewMode(graph).mode === "compact" });
}
function mountSVG(markup) {
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  if (parsed.querySelector("parsererror") || parsed.documentElement.localName !== "svg") throw new Error("Graphviz produced invalid SVG.");
  svg = document.importNode(parsed.documentElement, true);
  // Only Graphviz's drawing vocabulary is needed; labels never become HTML or links.
  const allowed = new Set(["svg", "g", "title", "polygon", "path", "ellipse", "text", "polyline", "rect"]);
  for (const node of [svg, ...svg.querySelectorAll("*")]) {
    if (!allowed.has(node.localName)) { node.remove(); continue; }
    for (const attr of [...node.attributes]) if (/^on/i.test(attr.name) || /href$/i.test(attr.name) || attr.name === "style") node.removeAttributeNode(attr);
  }
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.setAttribute("aria-label", active().graph.label || "Interactive graph preview");
  $("canvas").replaceChildren(svg);
  $("preview-message").hidden = true;
  baseView = svg.getAttribute("viewBox").split(/\s+/).map(Number);
  for (const group of svg.querySelectorAll(".node, .edge")) {
    const match = group.id.match(/^([neh])(\d+)/);
    if (!match) continue;
    const kind = match[1] === "n" ? "node" : "edge";
    const index = Number(match[2]);
    const graph = active().graph;
    const id = kind === "node" ? Object.keys(graph.nodes)[index] : index;
    const item = kind === "node" ? graph.nodes[id] : (graph.edges ?? graph.hyperedges)[index];
    const label = kind === "node" ? `Node: ${item.label ?? id}` : `${graph.hyperedges ? "Hyperedge" : "Edge"}: ${item.label ?? item.relation ?? index + 1}`;
    group.setAttribute("tabindex", "0");
    group.setAttribute("role", "button");
    group.setAttribute("aria-label", label);
    const title = group.querySelector("title");
    if (title) title.textContent = label;
    group.dataset.kind = kind;
    group.dataset.index = index;
    const select = event => {
      if (suppressClick) return;
      event.stopPropagation();
      selectItem(kind, id);
    };
    group.addEventListener("click", select);
    group.addEventListener("dblclick", event => { event.stopPropagation(); revealInSource(kind, id, true); });
    group.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(event); }
    });
  }
  for (const id of ["zoom-in", "zoom-out", "fit", "export-svg", "export-png"]) $(id).disabled = false;
  fit();
  paintSelection();
  search();
  attachPanZoom();
}
function itemPath(kind, id) {
  const { graph, path } = active();
  return kind === "node" ? pointer(`${path}/nodes`, id) : `${path}/${graph.edges ? "edges" : "hyperedges"}/${id}`;
}
function revealInSource(kind, id, focus = false) {
  const location = analysis.locations.get(itemPath(kind, id));
  if (!location) return;
  const from = location.keyStart ?? location.start;
  if (focus) editor.select(from, location.end);
  else editor.link({ from, to: location.end });
}
function selectItem(kind, id, { fromSource = false } = {}) {
  selection = { kind, id };
  paintSelection();
  showInspector();
  if (fromSource) editor.link(null);
  else if (editor.value === analyzedText) revealInSource(kind, id);
}
// Moving the cursor inside a node or edge in the source selects it in the diagram.
function selectFromSource(position) {
  if (!active() || hasErrors() || editor.value !== analyzedText) return;
  const { graph, path } = active();
  const prefix = `${path}/`;
  let best = null;
  for (const [candidate, location] of analysis.locations) {
    if (!candidate.startsWith(prefix)) continue;
    const from = location.keyStart ?? location.start;
    if (position < from || position > location.end) continue;
    const match = candidate.slice(prefix.length).match(/^(nodes|edges|hyperedges)\/([^/]+)$/);
    if (match && (!best || from >= best.from)) best = { from, kind: match[1] === "nodes" ? "node" : "edge", key: match[2] };
  }
  if (!best) return;
  const id = best.kind === "node" ? best.key.replaceAll("~1", "/").replaceAll("~0", "~") : Number(best.key);
  if (best.kind === "node" ? !Object.hasOwn(graph.nodes ?? {}, id) : !(graph.edges ?? graph.hyperedges)?.[id]) return;
  if (selection?.kind === best.kind && selection.id === id) return;
  selectItem(best.kind, id, { fromSource: true });
}
function paintSelection() {
  if (!svg || !active()) return;
  const selectedIndex = selection?.kind === "node" ? Object.keys(active().graph.nodes).indexOf(selection.id) : selection?.id;
  for (const group of svg.querySelectorAll("[data-kind]")) {
    const selected = selection && group.dataset.kind === selection.kind && Number(group.dataset.index) === selectedIndex;
    group.classList.toggle("selected", Boolean(selected));
    group.setAttribute("aria-pressed", String(Boolean(selected)));
  }
}
function showInspector() {
  const panel = $("inspector");
  panel.replaceChildren();
  $("clear-selection").hidden = !selection;
  if (!active()) {
    panel.append(element("h3", "No graph selected"), element("p", "Load a valid JSON Graph document to inspect its structure."));
    return;
  }
  const { graph, path } = active();
  let data = graph;
  let location = path;
  let heading = graph.label || graph.id || `Graph ${current + 1}`;
  let kind = "Graph overview";
  if (selection?.kind === "node") {
    data = graph.nodes[selection.id];
    location = pointer(`${path}/nodes`, selection.id);
    heading = data.label ?? selection.id;
    kind = "Node";
  } else if (selection?.kind === "edge") {
    data = (graph.edges ?? graph.hyperedges)[selection.id];
    location = `${path}/${graph.edges ? "edges" : "hyperedges"}/${selection.id}`;
    heading = data.label ?? data.relation ?? `${graph.edges ? "Edge" : "Hyperedge"} ${selection.id + 1}`;
    kind = graph.edges ? "Edge" : "Hyperedge";
  }
  panel.append(element("div", kind, "kind"), element("h3", heading));
  if (selection?.kind === "node") panel.append(element("p", `ID: ${selection.id}`));
  if (!selection) {
    const stats = graphStats(graph);
    const list = element("dl");
    for (const [label, value] of [["Direction", graph.directed === false ? "Undirected" : "Directed"], ["Nodes", stats.nodes], [graph.hyperedges ? "Hyperedges" : "Edges", stats.links], ["Components", stats.components], ["Isolated nodes", stats.isolated]]) {
      list.append(element("dt", label), element("dd", value));
    }
    panel.append(list);
  }
  panel.append(button("Show in source", () => selection ? revealInSource(selection.kind, selection.id, true) : jumpTo(location)));
  if (selection?.kind === "node") {
    const links = graph.edges ?? graph.hyperedges ?? [];
    const connected = links.map((edge, index) => ({ edge, index })).filter(({ edge }) => graph.edges
      ? edge.source === selection.id || edge.target === selection.id
      : (edge.nodes ?? [...edge.source, ...edge.target]).includes(selection.id));
    panel.append(element("h4", `Connections (${connected.length})`));
    for (const { edge, index } of connected) {
      const text = graph.edges ? `${edge.source} ${edge.directed ?? graph.directed ?? true ? "→" : "—"} ${edge.target}` : edge.label ?? edge.relation ?? `Hyperedge ${index + 1}`;
      panel.append(button(text, () => selectItem("edge", index), "connection"));
    }
  }
  panel.append(element("h4", selection ? "Source object" : "Graph metadata"));
  panel.append(element("pre", JSON.stringify(selection ? data : graph.metadata ?? {}, null, 2)));
}
function search() {
  const query = $("search").value.trim().toLocaleLowerCase();
  const results = $("search-results");
  results.replaceChildren();
  results.hidden = !query;
  const matches = new Set();
  if (query && active()) {
    for (const [index, [id, node]] of Object.entries(active().graph.nodes ?? {}).entries()) {
      if (`${id} ${node.label ?? ""}`.toLocaleLowerCase().includes(query)) {
        matches.add(index);
        const result = button(node.label ?? id, () => selectItem("node", id), "search-result");
        result.append(element("small", id));
        results.append(result);
      }
    }
  }
  if (query && !matches.size) results.append(element("p", "No matching nodes."));
  if (svg) for (const node of svg.querySelectorAll(".node[data-kind='node']")) {
    node.classList.toggle("matched", Boolean(query) && matches.has(Number(node.dataset.index)));
    node.classList.toggle("dimmed", Boolean(query) && !matches.has(Number(node.dataset.index)));
  }
}
function applyView() {
  if (!svg || !view) return;
  svg.setAttribute("viewBox", view.join(" "));
  const zoomLevel = baseView[2] / view[2];
  $("zoom-level").textContent = `${Math.round(zoomLevel * 100)}%`;
  $("zoom-out").disabled = zoomLevel <= MIN_ZOOM + 1e-6;
  $("zoom-in").disabled = zoomLevel >= MAX_ZOOM - 1e-6;
}
function fit() { if (baseView) { view = [...baseView]; applyView(); } }
function zoom(factor, point) {
  if (!svg || !view) return;
  const zoomLevel = baseView[2] / view[2];
  const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomLevel * factor));
  // The fitted view is the floor: zooming out further only adds empty space.
  if (nextZoom <= MIN_ZOOM) { fit(); return; }
  const ratio = zoomLevel / nextZoom;
  const center = point ?? { x: view[0] + view[2] / 2, y: view[1] + view[3] / 2 };
  view = [center.x - (center.x - view[0]) * ratio, center.y - (center.y - view[1]) * ratio, view[2] * ratio, view[3] * ratio];
  applyView();
}
function svgPoint(event) {
  const point = svg.createSVGPoint();
  point.x = event.clientX; point.y = event.clientY;
  return point.matrixTransform(svg.getScreenCTM().inverse());
}
function attachPanZoom() {
  let drag = null;
  svg.addEventListener("wheel", event => {
    event.preventDefault();
    zoom(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * .006), svgPoint(event));
  }, { passive: false });
  svg.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.target.closest("[data-kind]")) return;
    drag = { start: svgPoint(event), view: [...view], clientX: event.clientX, clientY: event.clientY };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener("pointermove", event => {
    if (!drag) return;
    if (Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) > 3) suppressClick = true;
    const point = svgPoint(event);
    view[0] += drag.start.x - point.x;
    view[1] += drag.start.y - point.y;
    applyView();
  });
  const finish = () => { drag = null; setTimeout(() => { suppressClick = false; }, 0); };
  svg.addEventListener("pointerup", finish);
  svg.addEventListener("pointercancel", finish);
  svg.addEventListener("click", () => { if (!suppressClick) { selection = null; paintSelection(); showInspector(); } });
}
function save(content, type, name) {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const link = element("a");
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function load(text, name, { baseline = text } = {}) {
  clearTimeout(editTimer);
  editor.setValue(text);
  lastLoaded = baseline;
  filename = name;
  current = 0;
  $("filename").textContent = name;
  $("filename").title = name;
  update();
  persist();
}
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ text: editor.value, name: filename, saved: editor.value === lastLoaded })); }
    catch { /* Storage full or disabled: the session simply is not remembered. */ }
  }, 400);
}
function restore() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (typeof stored?.text !== "string" || typeof stored.name !== "string") return false;
    load(stored.text, stored.name, { baseline: stored.saved ? stored.text : "" });
    status(`Restored ${stored.name} from your last visit. It is stored only in this browser.`);
    return true;
  } catch { return false; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ layout: $("layout").value, labels: $("labels").checked, details: $("diagnostic-details").checked })); } catch {}
}
function restoreSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
    if ([...$("layout").options].some(option => option.value === settings.layout)) $("layout").value = settings.layout;
    if (typeof settings.labels === "boolean") $("labels").checked = settings.labels;
    if (typeof settings.details === "boolean") $("diagnostic-details").checked = settings.details;
  } catch {}
}
function documentEdited() {
  job++;
  clearCanvas("Document changed. Updating the preview…");
  $("viewport").setAttribute("aria-busy", "true");
  clearTimeout(editTimer);
  editTimer = setTimeout(update, 350);
  persist();
}
function applyFix(fix) {
  if (editor.value !== analyzedText) {
    update();
    status("The document changed since it was checked. Diagnostics are refreshed; choose the fix again.");
    return;
  }
  // Keep documents that were already 2-space formatted that way after the edit.
  const wasFormatted = analysis.document !== null && analyzedText === JSON.stringify(analysis.document, null, 2);
  editor.applyEdits(fix.edits);
  if (wasFormatted) {
    const fixed = analyzeSource(editor.value);
    if (fixed.document !== null && !fixed.diagnostics.some(item => item.code === "duplicate-key")) editor.setValue(JSON.stringify(fixed.document, null, 2), { keepHistory: true });
  }
  update();
  persist();
  status(`Applied: ${fix.label}. Undo with Ctrl or Command + Z.`);
}
function mayReplace() {
  return editor.value === lastLoaded || window.confirm("Replace the current document? Save JSON first if you want to keep your changes.");
}
const MAX_FETCH_MS = 20000;
// GitHub page links return HTML; the raw host serves the file itself with CORS enabled.
function rawUrl(url) {
  const blob = url.hostname === "github.com" && url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
  if (blob) return new URL(`https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`);
  const gist = url.hostname === "gist.github.com" && url.pathname.match(/^\/([^/]+)\/([0-9a-f]+)\/?$/i);
  if (gist) return new URL(`https://gist.githubusercontent.com/${gist[1]}/${gist[2]}/raw`);
  return url;
}
function urlMessage(text, isError = false) {
  $("url-message").textContent = text;
  $("url-message").classList.toggle("error", isError);
}
async function readLimited(response) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_SOURCE_BYTES) throw new Error(`The document is ${(declared / 1048576).toFixed(1)} MiB; the limit is 2 MiB.`);
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SOURCE_BYTES) { reader.cancel(); throw new Error("The document exceeds the 2 MiB limit."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
async function loadFromUrl(input, { confirmReplace = true } = {}) {
  let url;
  try { url = new URL(input.trim(), location.href); } catch { urlMessage("Enter a complete URL, such as https://example.com/graph.json.", true); return false; }
  if (url.protocol !== "https:" && url.protocol !== "http:") { urlMessage(`Only http and https URLs can be loaded, not ${url.protocol}`, true); return false; }
  if (location.protocol === "https:" && url.protocol === "http:" && url.hostname !== "localhost") { urlMessage("This page is served over HTTPS, so the browser blocks plain HTTP downloads (mixed content). Use an https:// URL.", true); return false; }
  const target = rawUrl(url);
  if (confirmReplace && !mayReplace()) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_FETCH_MS);
  $("url-form").setAttribute("aria-busy", "true");
  $("url-submit").disabled = true;
  urlMessage(`Fetching ${target.href}${target.href !== url.href ? " (converted to the raw file)" : ""}…`);
  status(`Fetching ${target.host}…`);
  try {
    const response = await fetch(target, { signal: controller.signal, credentials: "omit", redirect: "follow", headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.5" } });
    if (!response.ok) throw new Error(`The server answered ${response.status}${response.statusText ? ` ${response.statusText}` : ""}. Check that the URL is correct and publicly readable.`);
    const type = response.headers.get("content-type") ?? "";
    if (/text\/html/i.test(type)) throw new Error("The server returned an HTML web page, not JSON. Link to the raw file instead (for GitHub, use the Raw button's URL).");
    const text = await readLimited(response);
    const name = decodeURIComponent(target.pathname.split("/").filter(Boolean).pop() || target.hostname) || "remote.json";
    load(text, name);
    const share = new URL(location.href);
    share.search = "";
    share.searchParams.set("url", url.href);
    history.replaceState(null, "", share);
    urlMessage(`Loaded ${plural(text.length, "character")} from ${target.host}. The address bar now links to this document.`);
    status(`Loaded ${name} from ${target.host}`);
    $("url-form").hidden = true;
    $("open-url").setAttribute("aria-expanded", "false");
    return true;
  } catch (error) {
    const message = error.name === "AbortError" ? `No response after ${MAX_FETCH_MS / 1000} seconds. The server may be slow or unreachable.`
      : error instanceof TypeError ? `The browser could not read ${target.host}. Most often the server does not allow cross-origin requests (CORS), or the host is unreachable. Raw links from GitHub, GitHub Gists, and most static hosts work; otherwise download the file and use Open JSON file.`
      : error.message;
    urlMessage(message, true);
    status(`Could not load the URL: ${message}`);
    $("url-form").hidden = false;
    $("open-url").setAttribute("aria-expanded", "true");
    return false;
  } finally {
    clearTimeout(timer);
    $("url-form").removeAttribute("aria-busy");
    $("url-submit").disabled = false;
  }
}
function clearSharedUrl() {
  if (!new URL(location.href).searchParams.has("url")) return;
  const plain = new URL(location.href);
  plain.searchParams.delete("url");
  history.replaceState(null, "", plain);
}
$("open-url").addEventListener("click", () => {
  const open = $("url-form").hidden;
  $("url-form").hidden = !open;
  $("open-url").setAttribute("aria-expanded", String(open));
  if (open) { $("url-input").focus(); $("url-input").select(); }
});
$("url-cancel").addEventListener("click", () => { $("url-form").hidden = true; $("open-url").setAttribute("aria-expanded", "false"); $("open-url").focus(); });
$("url-form").addEventListener("submit", event => { event.preventDefault(); loadFromUrl($("url-input").value); });
for (const control of document.querySelectorAll("[data-filter]")) control.addEventListener("click", () => { diagnosticFilter = control.dataset.filter; showDiagnostics(); });
$("diagnostic-details").addEventListener("change", () => $("diagnostics").classList.toggle("compact", !$("diagnostic-details").checked));
$("expand-diagnostics").addEventListener("click", event => {
  const expanded = $("source-pane").classList.toggle("diagnostics-expanded");
  event.currentTarget.setAttribute("aria-pressed", String(expanded));
  event.currentTarget.textContent = expanded ? "Collapse" : "Expand";
});
$("copy-report").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(diagnosticReport()); status("Diagnostics report copied to the clipboard."); }
  catch { save(diagnosticReport(), "text/plain", filename.replace(/\.json$/i, "") + "-diagnostics.txt"); status("Clipboard unavailable; the report was downloaded instead."); }
});
$("open").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (!mayReplace()) return;
  await openFile(file, true);
});
async function openFile(file, confirmed = false) {
  if (file.size > MAX_SOURCE_BYTES) { status("File exceeds the 2 MiB limit. Choose a smaller JSON document."); return; }
  if (!confirmed && !mayReplace()) return;
  try { load(await file.text(), file.name); clearSharedUrl(); status(`Opened ${file.name}.`); } catch (error) { status(`Cannot read file: ${error.message}`); }
}
$("example").addEventListener("click", () => { if (mayReplace()) { load(JSON.stringify(example, null, 2), "example.json"); clearSharedUrl(); } });
$("format").addEventListener("click", format);
function format() {
  const parsed = analyzeSource(editor.value);
  if (parsed.diagnostics.some(item => item.code === "duplicate-key") || !parsed.locations.size) {
    update();
    status("Cannot format this document. Resolve syntax errors or duplicate keys first.");
    return;
  }
  editor.setValue(JSON.stringify(parsed.document, null, 2), { keepHistory: true });
  update();
  persist();
}
$("download").addEventListener("click", () => {
  save(editor.value, "application/json", filename);
  lastLoaded = editor.value;
  persist();
  status("JSON download prepared.");
});
function exportedSvg() {
  const exported = svg.cloneNode(true);
  exported.setAttribute("viewBox", baseView.join(" "));
  exported.setAttribute("width", baseView[2]); exported.setAttribute("height", baseView[3]);
  exported.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  for (const node of exported.querySelectorAll("[data-kind]")) {
    node.removeAttribute("tabindex"); node.removeAttribute("role"); node.removeAttribute("aria-pressed");
    node.classList.remove("selected", "dimmed", "matched");
  }
  return new XMLSerializer().serializeToString(exported);
}
const baseName = () => filename.replace(/\.json$/i, "") || "graph";
$("export-svg").addEventListener("click", () => {
  if (!svg) return;
  save(exportedSvg(), "image/svg+xml", `${baseName()}.svg`);
  status("SVG download prepared.");
});
$("export-png").addEventListener("click", async () => {
  if (!svg) return;
  const scale = Math.min(2, 16000 / Math.max(baseView[2], baseView[3]));
  const image = new Image();
  const url = URL.createObjectURL(new Blob([exportedSvg()], { type: "image/svg+xml" }));
  try {
    image.src = url;
    await image.decode();
    const canvas = element("canvas");
    canvas.width = Math.ceil(baseView[2] * scale);
    canvas.height = Math.ceil(baseView[3] * scale);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("the image is too large for this browser");
    save(blob, "image/png", `${baseName()}.png`);
    status(`PNG download prepared (${canvas.width} × ${canvas.height}).`);
  } catch (error) {
    status(`Cannot create PNG: ${error.message}. Export SVG instead.`);
  } finally {
    URL.revokeObjectURL(url);
  }
});
$("export-dot").addEventListener("click", () => {
  if (!active() || hasErrors()) return;
  save(currentDot(), "text/vnd.graphviz", `${baseName()}.dot`);
  status("Graphviz DOT download prepared.");
});
$("graph-select").addEventListener("change", event => {
  current = Number(event.target.value); selection = null; $("search").value = ""; search(); render();
});
$("layout").addEventListener("change", () => { saveSettings(); render(); });
$("labels").addEventListener("change", () => { saveSettings(); render(); });
$("clear-selection").addEventListener("click", () => { selection = null; paintSelection(); showInspector(); });
$("search").addEventListener("input", search);
$("zoom-in").addEventListener("click", () => zoom(1.25));
$("zoom-out").addEventListener("click", () => zoom(.8));
$("fit").addEventListener("click", fit);
$("retry-engine").addEventListener("click", startWorker);
document.addEventListener("keydown", event => {
  if (event.defaultPrevented) return;
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); update(); }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); format(); }
  if (event.key === "Escape") { selection = null; paintSelection(); showInspector(); }
});
// Drop a JSON file, or a link dragged from another tab, anywhere on the page.
let dragDepth = 0;
const dragHasData = event => [...event.dataTransfer.types].some(type => type === "Files" || type === "text/uri-list");
window.addEventListener("dragenter", event => { if (!dragHasData(event)) return; event.preventDefault(); dragDepth++; $("drop-zone").hidden = false; });
window.addEventListener("dragover", event => { if (!dragHasData(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; });
window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("drop-zone").hidden = true; });
window.addEventListener("drop", async event => {
  if (!dragHasData(event)) return;
  event.preventDefault();
  dragDepth = 0;
  $("drop-zone").hidden = true;
  const [file] = event.dataTransfer.files;
  if (file) { await openFile(file); return; }
  const link = event.dataTransfer.getData("text/uri-list").split("\n").find(line => line && !line.startsWith("#"));
  if (link) { $("url-input").value = link.trim(); loadFromUrl(link.trim()); }
});
$("diagnostic-details").addEventListener("change", saveSettings);

restoreSettings();
const sharedUrl = new URL(location.href).searchParams.get("url");
if (!restore()) load(JSON.stringify(example, null, 2), "example.json");
// A shared ?url= link still asks before replacing unsaved work restored from this browser.
if (sharedUrl) { $("url-input").value = sharedUrl; loadFromUrl(sharedUrl); }

const deployed = document.querySelector("#deployed time");
if (deployed) {
  deployed.title = deployed.textContent;
  deployed.textContent = new Date(deployed.dateTime).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
