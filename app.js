import { analyzeSource, getGraphs, graphStats, layoutSize, toDot, pointer, MAX_SOURCE_BYTES, MAX_LAYOUT_NODES, MAX_LAYOUT_LINKS } from "./graph.js";
import { example } from "./example.js";

const $ = id => document.getElementById(id);
const source = $("source");
let analysis;
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

function updateCursor() {
  const before = source.value.slice(0, source.selectionStart);
  const lines = before.split("\n");
  $("cursor").textContent = `Ln ${lines.length}, Col ${lines.at(-1).length + 1}`;
}
function updateLines() {
  const count = source.value.split("\n").length;
  $("line-numbers").textContent = Array.from({ length: count }, (_, index) => index + 1).join("\n");
  $("line-numbers").scrollTop = source.scrollTop;
  updateCursor();
}
function jumpTo(path, start) {
  let location = analysis?.locations.get(path);
  while (!location && path) {
    path = path.slice(0, path.lastIndexOf("/"));
    location = analysis?.locations.get(path);
  }
  const from = start ?? location?.start ?? 0;
  const to = start === undefined ? location?.end ?? from : Math.min(from + 1, source.value.length);
  source.focus();
  source.setSelectionRange(from, to);
  const line = source.value.slice(0, from).split("\n").length - 1;
  source.scrollTop = Math.max(0, line * parseFloat(getComputedStyle(source).lineHeight) - source.clientHeight / 3);
  $("line-numbers").scrollTop = source.scrollTop;
  updateCursor();
}
function showDiagnostics() {
  const list = $("diagnostics");
  list.replaceChildren();
  const errors = analysis.diagnostics.filter(item => item.severity === "error").length;
  const warnings = analysis.diagnostics.length - errors;
  $("diagnostic-count").textContent = errors || warnings ? `${errors} errors · ${warnings} warnings` : "No issues";
  if (!analysis.diagnostics.length) {
    const healthy = element("div", "Document checks passed", "healthy");
    healthy.append(element("small", "Structure, field types, and node references are valid."));
    list.append(healthy);
  }
  for (const diagnostic of analysis.diagnostics) {
    const item = button("", () => jumpTo(diagnostic.path, diagnostic.start), `diagnostic ${diagnostic.severity}`);
    item.append(element("strong", diagnostic.severity === "error" ? "Error · " : "Warning · "), document.createTextNode(diagnostic.message), element("code", diagnostic.path || "/"));
    list.append(item);
  }
}
function clearCanvas(message) {
  svg = null;
  baseView = null;
  view = null;
  $("canvas").replaceChildren();
  $("preview-message").textContent = message;
  $("preview-message").hidden = !message;
  $("export").disabled = true;
  for (const id of ["zoom-in", "zoom-out", "fit"]) $(id).disabled = true;
  $("zoom-level").textContent = "—";
}
function update() {
  clearTimeout(editTimer);
  job++;
  selection = null;
  analysis = analyzeSource(source.value);
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
  updateLines();
  showInspector();
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
      const warnings = data.errors?.map(error => error.message).join("; ");
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
  $("graph-summary").textContent = `${stats.nodes} nodes · ${stats.links} ${graph.hyperedges ? "hyperedges" : "edges"} · ${stats.components} components · ${stats.isolated} isolated`;
  showInspector();
  const size = layoutSize(graph);
  if (size.nodes > MAX_LAYOUT_NODES || size.links > MAX_LAYOUT_LINKS) {
    clearCanvas(`Preview limit: ${MAX_LAYOUT_NODES} layout nodes and ${MAX_LAYOUT_LINKS} connections. This graph has ${size.nodes} and ${size.links}. Reduce it to preview; validation and source editing remain available.`);
    $("viewport").setAttribute("aria-busy", "false");
    status("Graph exceeds the interactive preview limit.");
    return;
  }
  if (!stats.nodes) {
    clearCanvas("This graph has no nodes yet. Add entries to its nodes object.");
    $("viewport").setAttribute("aria-busy", "false");
    status("Valid graph · No nodes to render");
    return;
  }
  clearCanvas(ready ? "Laying out the graph…" : "Waiting for the WASM layout engine…");
  $("viewport").setAttribute("aria-busy", "true");
  if (!ready) return;
  if (pending) { startWorker(); return; }
  const id = ++job;
  pending = true;
  workerTimer = setTimeout(() => engineFailure("Layout exceeded 12 seconds. Choose a simpler graph or a different layout, then retry the engine."), 12000);
  worker.postMessage({ id, dot: toDot(graph, $("labels").checked), engine: $("layout").value });
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
    group.dataset.kind = kind;
    group.dataset.index = index;
    const select = event => {
      if (suppressClick) return;
      event.stopPropagation();
      selectItem(kind, id);
    };
    group.addEventListener("click", select);
    group.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(event); }
    });
  }
  for (const id of ["zoom-in", "zoom-out", "fit"]) $(id).disabled = false;
  $("export").disabled = false;
  fit();
  paintSelection();
  search();
  attachPanZoom();
}
function selectItem(kind, id) {
  selection = { kind, id };
  paintSelection();
  showInspector();
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
  panel.append(button("Show in source", () => jumpTo(location)));
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
  $("zoom-level").textContent = `${Math.round(baseView[2] / view[2] * 100)}%`;
}
function fit() { if (baseView) { view = [...baseView]; applyView(); } }
function zoom(factor, point) {
  if (!svg || !view) return;
  const zoomLevel = baseView[2] / view[2];
  const nextZoom = Math.min(8, Math.max(.15, zoomLevel * factor));
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
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = element("a");
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function load(text, name) {
  clearTimeout(editTimer);
  source.value = text;
  lastLoaded = text;
  filename = name;
  current = 0;
  $("filename").textContent = name;
  $("filename").title = name;
  source.setSelectionRange(0, 0);
  source.scrollTop = 0;
  update();
}
function mayReplace() {
  return source.value === lastLoaded || window.confirm("Replace the current document? Save JSON first if you want to keep your changes.");
}
$("open").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > MAX_SOURCE_BYTES) { status("File exceeds the 2 MiB limit. Choose a smaller JSON document."); return; }
  if (!mayReplace()) return;
  try { load(await file.text(), file.name); } catch (error) { status(`Cannot read file: ${error.message}`); }
});
$("example").addEventListener("click", () => { if (mayReplace()) load(JSON.stringify(example, null, 2), "example.json"); });
$("format").addEventListener("click", format);
function format() {
  const parsed = analyzeSource(source.value);
  if (parsed.diagnostics.some(item => item.code === "duplicate-key") || !parsed.locations.size) {
    update();
    status("Cannot format this document. Resolve syntax errors or duplicate keys first.");
    return;
  }
  source.value = JSON.stringify(parsed.document, null, 2);
  update();
}
$("download").addEventListener("click", () => {
  save(source.value, "application/json", filename);
  lastLoaded = source.value;
  status("JSON download prepared.");
});
$("export").addEventListener("click", () => {
  if (!svg) return;
  const exported = svg.cloneNode(true);
  exported.setAttribute("viewBox", baseView.join(" "));
  exported.setAttribute("width", baseView[2]); exported.setAttribute("height", baseView[3]);
  exported.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  for (const node of exported.querySelectorAll("[data-kind]")) {
    node.removeAttribute("tabindex"); node.removeAttribute("role"); node.removeAttribute("aria-pressed");
    node.classList.remove("selected", "dimmed", "matched");
  }
  save(new XMLSerializer().serializeToString(exported), "image/svg+xml", filename.replace(/\.json$/i, "") + ".svg");
  status("SVG download prepared.");
});
$("graph-select").addEventListener("change", event => {
  current = Number(event.target.value); selection = null; $("search").value = ""; search(); render();
});
$("layout").addEventListener("change", render);
$("labels").addEventListener("change", render);
$("clear-selection").addEventListener("click", () => { selection = null; paintSelection(); showInspector(); });
$("search").addEventListener("input", search);
$("zoom-in").addEventListener("click", () => zoom(1.25));
$("zoom-out").addEventListener("click", () => zoom(.8));
$("fit").addEventListener("click", fit);
$("retry-engine").addEventListener("click", startWorker);
source.addEventListener("scroll", () => { $("line-numbers").scrollTop = source.scrollTop; });
for (const event of ["click", "keyup", "select"]) source.addEventListener(event, updateCursor);
source.addEventListener("input", () => {
  job++;
  updateLines();
  clearCanvas("Document changed. Updating the preview…");
  $("viewport").setAttribute("aria-busy", "true");
  clearTimeout(editTimer);
  editTimer = setTimeout(update, 350);
});
document.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); update(); }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); format(); }
  if (event.key === "Escape") { selection = null; paintSelection(); showInspector(); }
});
window.addEventListener("beforeunload", event => {
  if (source.value !== lastLoaded) { event.preventDefault(); event.returnValue = ""; }
});
load(JSON.stringify(example, null, 2), "example.json");
startWorker();
