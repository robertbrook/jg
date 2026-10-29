import { analyzeSource, applyEdits, attributePaths, diffGraphs, getGraphs, graphStats, previewMode, toDot, MAX_SOURCE_BYTES, MAX_COMPACT_NODES, MAX_COMPACT_LINKS } from "./graph.js";
import { createEditor } from "./editor.js";
import { examples } from "./example.js";
import { $, element, button, status, save } from "./ui.js";
import { showDiagnostics, diagnosticReport } from "./diagnostics-view.js";
import { parseDocumentUrl, fetchDocument, encodeShare, decodeShare, SHARE_WARN_LENGTH, SHARE_MAX_LENGTH } from "./loading.js";
import { createViewer } from "./viewer.js";
import { createLayoutEngine } from "./layout.js";
import { showInspector, itemPath } from "./inspector.js";

const STORAGE_KEY = `jg:document:${location.pathname}`;
const SETTINGS_KEY = "jg:settings";
const PANES = ["source", "preview", "inspector"];
let analysis;
let analyzedText = "";
let entries = [];
let current = 0;
let selection = null;
let diff = null;
let job = 0;
let editTimer;
let saveTimer;
let cursorTimer;
let undoTimer;
let applyingFix = false;
let lastLoaded = "";
let filename = "example.json";
let comparison = null;
let fileMode = "open";
let hiddenPanes = new Set();
let shownAttributes = { node: [], edge: [] };
const active = () => entries[current];
const hasErrors = () => analysis?.diagnostics.some(item => item.severity === "error");
const baseName = () => filename.replace(/\.json$/i, "") || "graph";

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

const viewer = createViewer({
  canvas: $("canvas"),
  minimap: $("minimap"),
  controls: { zoomIn: $("zoom-in"), zoomOut: $("zoom-out"), fit: $("fit"), level: $("zoom-level") },
  onSelect: (kind, id) => selectItem(kind, id),
  onClear: () => selectItem(null),
  onReveal: (kind, id) => revealInSource(kind, id, true)
});

const engine = createLayoutEngine({
  onStarting: () => { $("retry-engine").hidden = true; },
  onReady: () => { if (active() && !hasErrors()) render(); },
  onFailure: message => {
    $("retry-engine").hidden = false;
    clearCanvas(message);
    $("viewport").setAttribute("aria-busy", "false");
    status(message);
  },
  onResult: data => {
    if (data.id !== job) return;
    $("viewport").setAttribute("aria-busy", "false");
    if (!data.success) {
      const message = (data.errors ?? []).map(error => error.message).join("; ");
      clearCanvas(`Layout failed: ${message || "Graphviz returned no output"}.`);
      status("Layout failed. The document remains available in the editor.");
      return;
    }
    try {
      viewer.mount(data.svg, active().graph, active().graph.label || "Graph preview");
      $("preview-message").hidden = true;
      $("export").disabled = false;
      viewer.paint(selection, diff);
      // sfdp always reports the missing triangulation library in the WASM build; layout is unaffected.
      const warnings = data.errors?.map(error => error.message).filter(message => !message.includes("triangulation library")).join("; ");
      status(`Rendered in ${Math.round(data.duration)} ms${warnings ? ` · Graphviz: ${warnings}` : ""}`);
    } catch (error) {
      clearCanvas(`Cannot display the graph: ${error.message}`);
      status(`Preview failed: ${error.message}`);
    }
  }
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
function clearCanvas(message) {
  viewer.clear();
  $("preview-message").textContent = message;
  $("preview-message").hidden = !message;
  $("export").disabled = !active() || hasErrors();
}

// Compares the active graph with the matching graph (same id, else same position) in the baseline document.
function computeDiff() {
  if (!$("changes").checked || !active()) return null;
  const baseline = comparison?.text ?? lastLoaded;
  let before;
  try { before = getGraphs(JSON.parse(baseline)); } catch { return null; }
  const { graph } = active();
  const match = (graph.id !== undefined && before.find(entry => entry.graph?.id === graph.id)) || before[current];
  return diffGraphs(match?.graph ?? {}, graph);
}
function refreshDiff() {
  diff = computeDiff();
  viewer.paint(selection, diff);
  inspect();
}
function inspect() {
  $("clear-selection").hidden = !selection;
  showInspector($("inspector"), {
    entry: active(), index: current, selection, diff, shown: shownAttributes,
    onToggleAttribute: (kind, path, on) => setAttributeShown(kind, path, on),
    onSelect: (kind, id) => selectItem(kind, id),
    onReveal: (kind, id) => revealInSource(kind, id, true),
    onJump: path => jumpTo(path)
  });
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
  entries.forEach(({ graph }, index) => $("graph-select").append(new Option(graph.label || graph.id || `Graph ${index + 1}`, index)));
  if (!entries.length) $("graph-select").append(new Option(hasErrors() ? "Invalid document" : "No graphs"));
  $("graph-select").value = String(current);
  $("graph-select").disabled = !entries.length;
  showDiagnostics(analysis, analyzedText, { onJump: jumpTo, onFix: applyFix });
  diff = computeDiff();
  inspect();
  buildAttributeMenu();
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
function render() {
  if (!active() || hasErrors()) return;
  const { graph } = active();
  const stats = graphStats(graph);
  const size = previewMode(graph);
  $("graph-summary").textContent = `${stats.nodes} nodes · ${stats.links} ${graph.hyperedges ? "hyperedges" : "edges"}${size.mode === "compact" ? " · Large graph: dots only" : ""}`;
  if (size.mode === "too-large") {
    clearCanvas(`This graph has ${size.nodes} layout nodes and ${size.links} connections. In-browser layout supports up to ${MAX_COMPACT_NODES} and ${MAX_COMPACT_LINKS}. Validation, the inspector, and DOT export still work.`);
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
  clearCanvas(engine.ready ? `Laying out ${size.mode === "compact" ? `${size.nodes} nodes in large-graph mode` : "the graph"}…` : "Starting the WASM layout engine…");
  $("viewport").setAttribute("aria-busy", "true");
  const compact = size.mode === "compact";
  engine.layout(++job, currentDot(), compact ? "sfdp" : "dot", compact ? 30000 : 12000);
}
function currentDot() {
  const { graph } = active();
  return toDot(graph, { labels: $("labels").checked, compact: previewMode(graph).mode === "compact", attributes: shownAttributes });
}
function setAttributeShown(kind, path, on) {
  const rest = shownAttributes[kind].filter(item => item !== path);
  shownAttributes = { ...shownAttributes, [kind]: on ? [...rest, path] : rest };
  const focused = $("inspector").contains(document.activeElement) ? document.activeElement.getAttribute("aria-label") : null;
  saveSettings();
  buildAttributeMenu();
  inspect();
  if (focused) $("inspector").querySelector(`[aria-label="${CSS.escape(focused)}"]`)?.focus();
  render();
}
// Lists the attributes the active graph uses; ticked ones appear as extra lines in the diagram's labels.
function buildAttributeMenu() {
  const box = $("attribute-options");
  box.replaceChildren();
  const available = active() ? attributePaths(active().graph) : { node: [], edge: [] };
  const chosen = shownAttributes.node.length + shownAttributes.edge.length;
  $("attributes-menu").querySelector("summary").textContent = chosen ? `Attributes (${chosen})` : "Attributes";
  if (!available.node.length && !available.edge.length) { box.append(element("p", "This graph has no additional attributes.")); return; }
  for (const [kind, title] of [["node", "Nodes"], ["edge", active().graph.hyperedges ? "Hyperedges" : "Edges"]]) {
    if (!available[kind].length) continue;
    const group = element("fieldset");
    group.append(element("legend", title));
    for (const path of available[kind]) {
      const label = element("label", undefined, "checkbox");
      const input = element("input");
      input.type = "checkbox";
      input.checked = shownAttributes[kind].includes(path);
      input.addEventListener("change", () => {
        setAttributeShown(kind, path, input.checked);
        box.querySelector(`input[data-path="${CSS.escape(`${kind}:${path}`)}"]`)?.focus();
      });
      input.dataset.path = `${kind}:${path}`;
      label.append(input, ` ${path}`);
      group.append(label);
    }
    box.append(group);
  }
  if (chosen) box.append(button("Clear all", () => { shownAttributes = { node: [], edge: [] }; saveSettings(); buildAttributeMenu(); render(); }));
}

function revealInSource(kind, id, focus = false) {
  const location = analysis.locations.get(itemPath(active(), kind, id));
  if (!location) return;
  const from = location.keyStart ?? location.start;
  if (focus) editor.select(from, location.end);
  else editor.link({ from, to: location.end });
}
function selectItem(kind, id, { fromSource = false } = {}) {
  selection = kind ? { kind, id } : null;
  viewer.paint(selection, diff);
  inspect();
  if (!selection || fromSource) editor.link(null);
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
function mayReplace() {
  return editor.value === lastLoaded || window.confirm("Replace the current document? Save JSON first if you want to keep your changes.");
}
function documentEdited() {
  if (!applyingFix) hideUndo();
  job++;
  clearCanvas("Document changed. Updating the preview…");
  $("viewport").setAttribute("aria-busy", "true");
  clearTimeout(editTimer);
  editTimer = setTimeout(update, 350);
  persist();
}
function hideUndo() { clearTimeout(undoTimer); $("undo").hidden = true; }
function applyFix(fix) {
  if (editor.value !== analyzedText) {
    update();
    status("The document changed since it was checked. Diagnostics are refreshed; choose the fix again.");
    return;
  }
  // Keep documents that were already 2-space formatted that way. One edit means one undo step.
  const wasFormatted = analysis.document !== null && analyzedText === JSON.stringify(analysis.document, null, 2);
  applyingFix = true;
  try {
    const fixedText = applyEdits(analyzedText, fix.edits);
    const fixed = wasFormatted ? analyzeSource(fixedText) : null;
    if (fixed?.document != null && !fixed.diagnostics.some(item => item.code === "duplicate-key")) editor.setValue(JSON.stringify(fixed.document, null, 2), { silent: false, keepHistory: true });
    else editor.applyEdits(fix.edits);
  } finally { applyingFix = false; }
  update();
  persist();
  status(`Applied: ${fix.label}.`);
  $("undo").hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndo, 15000);
}
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

function applyPanes() {
  for (const pane of PANES) {
    const hidden = hiddenPanes.has(pane);
    $(`${pane}-pane`).classList.toggle("collapsed", hidden);
    $("workspace").classList.toggle(`hide-${pane}`, hidden);
    document.querySelector(`.pane-tab[data-pane="${pane}"]`).setAttribute("aria-expanded", String(!hidden));
  }
  // Keep at least one pane visible.
  const last = hiddenPanes.size === PANES.length - 1;
  for (const control of document.querySelectorAll(".pane-hide")) control.disabled = last && !hiddenPanes.has(control.dataset.pane);
}
function setPaneHidden(pane, hidden) {
  if (hidden && hiddenPanes.size >= PANES.length - 1) return;
  hiddenPanes[hidden ? "add" : "delete"](pane);
  applyPanes();
  saveSettings();
  if (!hidden) (pane === "source" ? editor.focus() : $(`${pane}-pane`).querySelector(".pane-hide").focus());
  else document.querySelector(`.pane-tab[data-pane="${pane}"]`).focus();
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ labels: $("labels").checked, hiddenPanes: [...hiddenPanes], attributes: shownAttributes })); } catch {}
}
function restoreSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
    if (typeof settings.labels === "boolean") $("labels").checked = settings.labels;
    for (const kind of ["node", "edge"]) if (Array.isArray(settings.attributes?.[kind])) shownAttributes[kind] = settings.attributes[kind].filter(path => typeof path === "string").slice(0, 20);
    if (Array.isArray(settings.hiddenPanes)) hiddenPanes = new Set(settings.hiddenPanes.filter(pane => PANES.includes(pane)).slice(0, PANES.length - 1));
  } catch {}
  applyPanes();
}

function urlMessage(text, isError = false) {
  $("url-message").textContent = text;
  $("url-message").classList.toggle("error", isError);
}
function showUrlForm(show) {
  $("url-form").hidden = !show;
  if (show) { $("url-input").focus(); $("url-input").select(); }
}
async function loadFromUrl(input, { confirmReplace = true } = {}) {
  let parsed;
  try { parsed = parseDocumentUrl(input); } catch (error) { urlMessage(error.message, true); showUrlForm(true); return false; }
  const { url, target } = parsed;
  if (confirmReplace && !mayReplace()) return false;
  $("url-form").setAttribute("aria-busy", "true");
  $("url-submit").disabled = true;
  urlMessage(`Fetching ${target.href}${target.href !== url.href ? " (converted to the raw file)" : ""}…`);
  status(`Fetching ${target.host}…`);
  try {
    const { text, name } = await fetchDocument(target);
    load(text, name);
    const share = new URL(location.href);
    share.search = "";
    share.hash = "";
    share.searchParams.set("url", url.href);
    history.replaceState(null, "", share);
    status(`Loaded ${name} from ${target.host}. The address bar now links to this document.`);
    showUrlForm(false);
    return true;
  } catch (error) {
    urlMessage(error.message, true);
    status(`Could not load the URL: ${error.message}`);
    showUrlForm(true);
    return false;
  } finally {
    $("url-form").removeAttribute("aria-busy");
    $("url-submit").disabled = false;
  }
}
function clearSharedUrl() {
  const plain = new URL(location.href);
  if (!plain.searchParams.has("url") && !plain.hash) return;
  plain.searchParams.delete("url");
  plain.hash = "";
  history.replaceState(null, "", plain);
}
async function openFile(file, confirmed = false) {
  if (file.size > MAX_SOURCE_BYTES) { status("File exceeds the 2 MiB limit. Choose a smaller JSON document."); return; }
  if (!confirmed && !mayReplace()) return;
  try { load(await file.text(), file.name); clearSharedUrl(); status(`Opened ${file.name}.`); } catch (error) { status(`Cannot read file: ${error.message}`); }
}
async function compareWith(file) {
  if (file.size > MAX_SOURCE_BYTES) { status("File exceeds the 2 MiB limit."); return; }
  try {
    const text = await file.text();
    JSON.parse(text);
    comparison = { text, name: file.name };
    $("changes").checked = true;
    refreshDiff();
    status(`Comparing with ${file.name}. Added items are green, changed items amber; removed items are listed in the Inspector.`);
  } catch (error) { status(`Cannot compare with ${file.name}: ${error.message}`); }
}
async function share() {
  try {
    const url = new URL(location.href);
    url.search = "";
    url.hash = `doc=${await encodeShare(editor.value, filename)}`;
    const size = url.href.length;
    const alternative = "Save JSON and send the file, or publish it (for example as a GitHub Gist) and share a ?url= link.";
    if (size > SHARE_MAX_LENGTH) { status(`This document is too large for a share link (${size.toLocaleString()} characters). ${alternative}`); return; }
    const note = size > SHARE_WARN_LENGTH ? ` It is ${size.toLocaleString()} characters long; chat and email apps may cut it off. ${alternative}` : " The document travels in the link; nothing is uploaded.";
    try { await navigator.clipboard.writeText(url.href); status(`Share link copied.${note}`); }
    catch { window.prompt("Copy this link:", url.href); status(`Share link created.${note}`); }
  } catch (error) { status(`Cannot create a share link: ${error.message}`); }
}
async function openSharedDocument(encoded) {
  try {
    const { text, name } = await decodeShare(encoded);
    if (!mayReplace()) return;
    load(text, name, { baseline: text });
    status(`Opened ${name} from a share link.`);
  } catch (error) {
    status(`Cannot open the share link: ${error.message}`);
  } finally {
    clearSharedUrl();
  }
}

// Controls
for (const control of document.querySelectorAll(".pane-hide")) control.addEventListener("click", () => setPaneHidden(control.dataset.pane, true));
for (const control of document.querySelectorAll(".pane-tab")) control.addEventListener("click", () => setPaneHidden(control.dataset.pane, false));
for (const [kind, label] of [["valid", "Examples"], ["debug", "Debugging practice"]]) {
  const group = element("optgroup");
  group.label = label;
  for (const item of examples.filter(entry => entry.kind === kind)) group.append(new Option(item.name, item.id));
  $("example").append(group);
}
$("example").addEventListener("change", event => {
  const item = examples.find(entry => entry.id === event.target.value);
  event.target.value = "";
  if (item && mayReplace()) { load(item.text, item.file); clearSharedUrl(); }
});
$("open").addEventListener("change", event => {
  const choice = event.target.value;
  event.target.value = "";
  if (choice === "url") showUrlForm(true);
  if (choice === "file" || choice === "compare") { fileMode = choice; $("file").click(); }
});
$("file").addEventListener("change", async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (fileMode === "compare") { compareWith(file); return; }
  if (mayReplace()) await openFile(file, true);
});
$("url-cancel").addEventListener("click", () => { showUrlForm(false); $("open").focus(); });
$("url-form").addEventListener("submit", event => { event.preventDefault(); loadFromUrl($("url-input").value); });
$("expand-diagnostics").addEventListener("click", event => {
  const expanded = $("source-pane").classList.toggle("diagnostics-expanded");
  event.currentTarget.setAttribute("aria-pressed", String(expanded));
  event.currentTarget.textContent = expanded ? "Collapse" : "Expand";
});
$("copy-report").addEventListener("click", async () => {
  const report = diagnosticReport(analysis, filename);
  try { await navigator.clipboard.writeText(report); status("Diagnostics report copied to the clipboard."); }
  catch { save(report, "text/plain", `${baseName()}-diagnostics.txt`); status("Clipboard unavailable; the report was downloaded instead."); }
});
$("format").addEventListener("click", format);
$("download").addEventListener("click", () => {
  save(editor.value, "application/json", filename);
  lastLoaded = editor.value;
  persist();
  if (!comparison) refreshDiff();
  status("JSON download prepared.");
});
$("share").addEventListener("click", share);
$("undo").addEventListener("click", () => { editor.undo(); hideUndo(); status("Fix undone."); editor.focus(); });
$("export").addEventListener("change", async event => {
  const choice = event.target.value;
  event.target.value = "";
  if (!active() || hasErrors()) return;
  if (choice === "dot") { save(currentDot(), "text/vnd.graphviz", `${baseName()}.dot`); status("Graphviz DOT download prepared."); return; }
  if (!viewer.mounted) { status("Wait for the preview to finish, then export again."); return; }
  if (choice === "svg") { save(viewer.exportedSvg(), "image/svg+xml", `${baseName()}.svg`); status("SVG download prepared."); }
  if (choice === "png") {
    try {
      const { blob, width, height } = await viewer.exportedPng();
      save(blob, "image/png", `${baseName()}.png`);
      status(`PNG download prepared (${width} × ${height}).`);
    } catch (error) { status(`Cannot create PNG: ${error.message}. Export SVG instead.`); }
  }
});
$("graph-select").addEventListener("change", event => { current = Number(event.target.value); selection = null; diff = computeDiff(); inspect(); buildAttributeMenu(); render(); });
$("labels").addEventListener("change", () => { saveSettings(); render(); });
$("changes").addEventListener("change", () => {
  if (!$("changes").checked) comparison = null;
  refreshDiff();
  if ($("changes").checked) status(comparison ? `Comparing with ${comparison.name}.` : lastLoaded ? "Highlighting changes since this document was opened or saved." : "No opened or saved version to compare with. Use Open › Compare with file.");
});
$("clear-selection").addEventListener("click", () => selectItem(null));
$("zoom-in").addEventListener("click", () => viewer.zoom(1.25));
$("zoom-out").addEventListener("click", () => viewer.zoom(.8));
$("fit").addEventListener("click", () => viewer.fit());
$("retry-engine").addEventListener("click", () => { engine.start(); });
document.addEventListener("keydown", event => {
  if (event.defaultPrevented) return;
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); update(); }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); format(); }
  if (event.key === "Escape") { if ($("attributes-menu").open) { $("attributes-menu").open = false; $("attributes-menu").querySelector("summary").focus(); } else selectItem(null); }
});
document.addEventListener("click", event => { if (!event.target.closest("#attributes-menu")) $("attributes-menu").open = false; });
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

// Startup
restoreSettings();
const page = new URL(location.href);
const sharedUrl = page.searchParams.get("url");
const sharedDoc = page.hash.match(/^#doc=([\w-]+)$/)?.[1];
if (!restore()) load(examples[0].text, examples[0].file);
// Shared links still ask before replacing unsaved work restored from this browser.
if (sharedDoc) openSharedDocument(sharedDoc);
else if (sharedUrl) { $("url-input").value = sharedUrl; loadFromUrl(sharedUrl); }

const deployed = document.querySelector("#deployed time");
if (deployed) {
  deployed.title = deployed.textContent;
  deployed.textContent = new Date(deployed.dateTime).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
// Works offline after the first visit. Network first, so a new deployment is picked up on the next load.
if ("serviceWorker" in navigator && (location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname))) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
