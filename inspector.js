import { graphStats, pointer } from "./graph.js";
import { element, button, plural } from "./ui.js";

const MAX_OUTLINE = 300;
const URL_STRING = /"(https?:\/\/[^"\\\s]+)"/g;

/** Pretty-printed JSON in which http(s) string values are links. */
export function jsonView(value) {
  const text = JSON.stringify(value, null, 2) ?? "undefined";
  const block = element("pre");
  let last = 0;
  for (const match of text.matchAll(URL_STRING)) {
    let url;
    try { url = new URL(match[1]); } catch { continue; }
    block.append(text.slice(last, match.index + 1));
    const link = element("a", match[1]);
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    block.append(link);
    last = match.index + match[0].length - 1;
  }
  block.append(text.slice(last));
  return block;
}

const linkText = (graph, edge, index) => graph.edges
  ? `${edge.source} ${edge.directed ?? graph.directed ?? true ? "→" : "—"} ${edge.target}${edge.relation ? ` (${edge.relation})` : ""}`
  : edge.label ?? edge.relation ?? `Hyperedge ${index + 1}`;

// A text version of the graph, for screen readers and for reading large graphs.
function outline(graph, onSelect) {
  const ids = Object.keys(graph.nodes ?? {});
  const box = element("details", undefined, "outline");
  box.append(element("summary", `Outline (${plural(ids.length, "node")})`));
  const list = element("ul");
  for (const id of ids.slice(0, MAX_OUTLINE)) {
    const item = element("li");
    item.append(button(graph.nodes[id]?.label ?? id, () => onSelect("node", id), "link-button"));
    const targets = (graph.edges ?? []).filter(edge => edge.source === id).map(edge => graph.nodes[edge.target]?.label ?? edge.target);
    if (targets.length) item.append(element("span", ` → ${targets.join(", ")}`));
    list.append(item);
  }
  box.append(list);
  if (ids.length > MAX_OUTLINE) box.append(element("p", `Showing the first ${MAX_OUTLINE} nodes.`));
  return box;
}

function changes(diff) {
  const box = element("section", undefined, "changes");
  box.append(element("h4", "Changes since compared version"));
  for (const [label, part] of [["Nodes", diff.nodes], ["Links", diff.links]]) {
    box.append(element("p", `${label}: ${part.added.size} added · ${part.changed.size} changed · ${part.removed.length} removed`));
  }
  const removed = [...diff.nodes.removed.map(text => `Node ${text}`), ...diff.links.removed.map(text => `Link ${text}`)];
  if (removed.length) {
    const items = element("ul");
    for (const text of removed.slice(0, 50)) items.append(element("li", text));
    box.append(element("p", "Removed:"), items);
  }
  return box;
}

/**
 * @param {HTMLElement} panel
 * @param {{ entry?: { graph, path }, index: number, selection, diff, onSelect(kind, id): void, onReveal(kind, id): void, onJump(path): void }} state
 */
export function showInspector(panel, { entry, index, selection, diff, onSelect, onReveal, onJump }) {
  panel.replaceChildren();
  if (!entry) {
    panel.append(element("h3", "No graph selected"), element("p", "Load a valid JSON Graph document to inspect its structure."));
    return;
  }
  const { graph, path } = entry;
  const links = graph.edges ?? graph.hyperedges ?? [];
  let data = graph.metadata ?? {};
  let heading = graph.label || graph.id || `Graph ${index + 1}`;
  let kind = "Graph overview";
  if (selection?.kind === "node") {
    data = graph.nodes[selection.id];
    heading = data.label ?? selection.id;
    kind = "Node";
  } else if (selection?.kind === "edge") {
    data = links[selection.id];
    heading = data.label ?? data.relation ?? `${graph.edges ? "Edge" : "Hyperedge"} ${selection.id + 1}`;
    kind = graph.edges ? "Edge" : "Hyperedge";
  }
  panel.append(element("div", kind, "kind"), element("h3", heading));
  if (selection?.kind === "node") panel.append(element("p", `ID: ${selection.id}`));
  if (selection?.kind === "edge" && graph.edges) panel.append(element("p", linkText(graph, data, selection.id)));
  if (!selection) {
    const stats = graphStats(graph);
    const list = element("dl");
    for (const [label, value] of [["Direction", graph.directed === false ? "Undirected" : "Directed"], ["Nodes", stats.nodes], [graph.hyperedges ? "Hyperedges" : "Edges", stats.links], ["Components", stats.components], ["Isolated nodes", stats.isolated]]) {
      list.append(element("dt", label), element("dd", value));
    }
    panel.append(list);
  }
  panel.append(button("Show in source", () => selection ? onReveal(selection.kind, selection.id) : onJump(path)));
  if (selection?.kind === "node") {
    const connected = links.map((edge, position) => ({ edge, position })).filter(({ edge }) => graph.edges
      ? edge.source === selection.id || edge.target === selection.id
      : (edge.nodes ?? [...(edge.source ?? []), ...(edge.target ?? [])]).includes(selection.id));
    panel.append(element("h4", `Connections (${connected.length})`));
    for (const { edge, position } of connected) panel.append(button(linkText(graph, edge, position), () => onSelect("edge", position), "connection"));
  }
  if (!selection && diff) panel.append(changes(diff));
  if (!selection && graph.nodes) panel.append(outline(graph, onSelect));
  panel.append(element("h4", selection ? "Source object" : "Graph metadata"), jsonView(data));
}

export const itemPath = ({ graph, path }, kind, id) => kind === "node" ? pointer(`${path}/nodes`, id) : `${path}/${graph.edges ? "edges" : "hyperedges"}/${id}`;
