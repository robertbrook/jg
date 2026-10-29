// The interactive diagram: sanitised Graphviz SVG with pan, zoom, a minimap, keyboard navigation, and export.
const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const ALLOWED = new Set(["svg", "g", "title", "polygon", "path", "ellipse", "text", "polyline", "rect"]);
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * @param {{ canvas: HTMLElement, minimap: HTMLElement, controls: { zoomIn: HTMLButtonElement, zoomOut: HTMLButtonElement, fit: HTMLButtonElement, level: HTMLOutputElement },
 *   onSelect(kind: "node"|"edge", id: string|number): void, onClear(): void, onReveal(kind, id): void }} options
 */
export function createViewer({ canvas, minimap, controls, onSelect, onClear, onReveal }) {
  let svg = null;
  let graph = null;
  let baseView = null;
  let view = null;
  let mini = null;
  let suppressClick = false;
  let centers = new Map();
  let nodeGroups = new Map();

  const zoomLevel = () => baseView[2] / view[2];
  function setControls(enabled) {
    for (const control of [controls.zoomIn, controls.zoomOut, controls.fit]) control.disabled = !enabled;
    if (!enabled) controls.level.textContent = "—";
  }
  function applyView() {
    if (!svg || !view) return;
    svg.setAttribute("viewBox", view.join(" "));
    const level = zoomLevel();
    controls.level.textContent = `${Math.round(level * 100)}%`;
    controls.zoomOut.disabled = level <= MIN_ZOOM + 1e-6;
    controls.zoomIn.disabled = level >= MAX_ZOOM - 1e-6;
    // The minimap only helps once part of the graph is out of view.
    minimap.hidden = level <= MIN_ZOOM + 1e-6;
    if (mini) for (const [attribute, value] of [["x", view[0]], ["y", view[1]], ["width", view[2]], ["height", view[3]]]) mini.rect.setAttribute(attribute, value);
  }
  function fit() { if (baseView) { view = [...baseView]; applyView(); } }
  function zoom(factor, point) {
    if (!svg || !view) return;
    const level = zoomLevel();
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, level * factor));
    // The fitted view is the floor: zooming out further only adds empty space.
    if (next <= MIN_ZOOM) { fit(); return; }
    const ratio = level / next;
    const center = point ?? { x: view[0] + view[2] / 2, y: view[1] + view[3] / 2 };
    view = [center.x - (center.x - view[0]) * ratio, center.y - (center.y - view[1]) * ratio, view[2] * ratio, view[3] * ratio];
    applyView();
  }
  function centerOn(point) {
    view[0] = point.x - view[2] / 2;
    view[1] = point.y - view[3] / 2;
    applyView();
  }
  function svgPoint(target, event) {
    const point = target.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    return point.matrixTransform(target.getScreenCTM().inverse());
  }
  function clear() {
    svg = null; graph = null; baseView = null; view = null; mini = null;
    centers = new Map();
    nodeGroups = new Map();
    canvas.replaceChildren();
    minimap.replaceChildren();
    minimap.hidden = true;
    setControls(false);
  }

  function attachPanZoom() {
    let drag = null;
    svg.addEventListener("wheel", event => {
      event.preventDefault();
      zoom(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * .006), svgPoint(svg, event));
    }, { passive: false });
    svg.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest("[data-kind]")) return;
      drag = { start: svgPoint(svg, event), clientX: event.clientX, clientY: event.clientY };
      svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener("pointermove", event => {
      if (!drag) return;
      if (Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) > 3) suppressClick = true;
      const point = svgPoint(svg, event);
      view[0] += drag.start.x - point.x;
      view[1] += drag.start.y - point.y;
      applyView();
    });
    const finish = () => { drag = null; setTimeout(() => { suppressClick = false; }, 0); };
    svg.addEventListener("pointerup", finish);
    svg.addEventListener("pointercancel", finish);
    svg.addEventListener("click", () => { if (!suppressClick) onClear(); });
  }

  function buildMinimap() {
    const copy = svg.cloneNode(true);
    for (const node of [copy, ...copy.querySelectorAll("*")]) for (const attribute of ["id", "tabindex", "role", "aria-label", "aria-pressed"]) node.removeAttribute(attribute);
    copy.querySelectorAll("title").forEach(title => title.remove());
    copy.setAttribute("viewBox", baseView.join(" "));
    copy.setAttribute("focusable", "false");
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("class", "minimap-view");
    rect.setAttribute("vector-effect", "non-scaling-stroke");
    copy.append(rect);
    minimap.replaceChildren(copy);
    mini = { svg: copy, rect };
    let dragging = false;
    const move = event => { if (dragging) centerOn(svgPoint(copy, event)); };
    copy.addEventListener("pointerdown", event => { dragging = true; copy.setPointerCapture(event.pointerId); move(event); });
    copy.addEventListener("pointermove", move);
    copy.addEventListener("pointerup", () => { dragging = false; });
    copy.addEventListener("pointercancel", () => { dragging = false; });
  }

  // Arrow keys move from a focused node to the nearest node in that direction, preferring connected nodes.
  function neighbours(id) {
    const result = new Set();
    for (const edge of graph.edges ?? []) {
      if (edge.source === id) result.add(edge.target);
      if (edge.target === id) result.add(edge.source);
    }
    for (const edge of graph.hyperedges ?? []) {
      const members = edge.nodes ?? [...(edge.source ?? []), ...(edge.target ?? [])];
      if (members.includes(id)) members.forEach(member => result.add(member));
    }
    result.delete(id);
    return result;
  }
  function step(id, [dx, dy]) {
    // Measured on first use: the SVG has no geometry while its pane is hidden.
    if (!centers.size) for (const [key, group] of nodeGroups) {
      const box = group.getBBox();
      centers.set(key, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    }
    const from = centers.get(id);
    if (!from) return null;
    const pick = candidates => {
      let best = null;
      for (const candidate of candidates) {
        const to = centers.get(candidate);
        if (!to || candidate === id) continue;
        const along = (to.x - from.x) * dx + (to.y - from.y) * dy;
        const across = Math.abs((to.x - from.x) * dy - (to.y - from.y) * dx);
        if (along <= 0 || across > along * 2) continue;
        const score = along + across * 2;
        if (!best || score < best.score) best = { id: candidate, score };
      }
      return best?.id ?? null;
    };
    return pick(neighbours(id)) ?? pick(centers.keys());
  }
  function focusNode(id) {
    const group = nodeGroups.get(id);
    if (!group) return;
    const center = centers.get(id);
    if (center && (center.x < view[0] || center.x > view[0] + view[2] || center.y < view[1] || center.y > view[1] + view[3])) centerOn(center);
    group.focus({ preventScroll: true });
  }

  function mount(markup, currentGraph, label) {
    const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
    if (parsed.querySelector("parsererror") || parsed.documentElement.localName !== "svg") throw new Error("Graphviz produced invalid SVG.");
    clear();
    svg = document.importNode(parsed.documentElement, true);
    graph = currentGraph;
    // Only Graphviz's drawing vocabulary is needed; labels never become HTML or links.
    for (const node of [svg, ...svg.querySelectorAll("*")]) {
      if (!ALLOWED.has(node.localName)) { node.remove(); continue; }
      for (const attr of [...node.attributes]) if (/^on/i.test(attr.name) || /href$/i.test(attr.name) || attr.name === "style") node.removeAttributeNode(attr);
    }
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.setAttribute("role", "group");
    svg.setAttribute("aria-label", `${label}. Tab to a node, then use the arrow keys to move between nodes.`);
    canvas.replaceChildren(svg);
    baseView = svg.getAttribute("viewBox").split(/\s+/).map(Number);
    const nodeIds = Object.keys(graph.nodes ?? {});
    const links = graph.edges ?? graph.hyperedges ?? [];
    for (const group of svg.querySelectorAll(".node, .edge")) {
      const match = group.id.match(/^([neh])(\d+)/);
      if (!match) continue;
      const kind = match[1] === "n" ? "node" : "edge";
      const index = Number(match[2]);
      const id = kind === "node" ? nodeIds[index] : index;
      const item = kind === "node" ? graph.nodes[id] : links[index];
      const text = kind === "node" ? `Node: ${item.label ?? id}` : `${graph.hyperedges ? "Hyperedge" : "Edge"}: ${item.label ?? item.relation ?? index + 1}`;
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.setAttribute("aria-label", text);
      const title = group.querySelector("title");
      if (title) title.textContent = text;
      group.dataset.kind = kind;
      group.dataset.index = index;
      if (kind === "node") nodeGroups.set(id, group);
      const select = event => {
        if (suppressClick) return;
        event.stopPropagation();
        onSelect(kind, id);
      };
      group.addEventListener("click", select);
      group.addEventListener("dblclick", event => { event.stopPropagation(); onReveal(kind, id); });
      group.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(event); return; }
        if (kind !== "node" || !ARROWS[event.key]) return;
        event.preventDefault();
        const next = step(id, ARROWS[event.key]);
        if (next !== null) { focusNode(next); onSelect("node", next); }
      });
    }
    buildMinimap();
    setControls(true);
    fit();
    attachPanZoom();
  }

  /** Marks the selection and, when a diff is given, added and changed items. */
  function paint(selection, diff) {
    if (!svg) return;
    const nodeIds = Object.keys(graph.nodes ?? {});
    const selectedIndex = selection?.kind === "node" ? nodeIds.indexOf(selection.id) : selection?.id;
    for (const group of svg.querySelectorAll("[data-kind]")) {
      const index = Number(group.dataset.index);
      const isNode = group.dataset.kind === "node";
      const selected = Boolean(selection) && group.dataset.kind === selection.kind && index === selectedIndex;
      group.classList.toggle("selected", selected);
      group.setAttribute("aria-pressed", String(selected));
      const changes = isNode ? diff?.nodes : diff?.links;
      const key = isNode ? nodeIds[index] : index;
      group.classList.toggle("added", Boolean(changes?.added.has(key)));
      group.classList.toggle("changed", Boolean(changes?.changed.has(key)));
    }
  }

  function exportedSvg() {
    const exported = svg.cloneNode(true);
    exported.setAttribute("viewBox", baseView.join(" "));
    exported.setAttribute("width", baseView[2]); exported.setAttribute("height", baseView[3]);
    exported.setAttribute("xmlns", SVG_NS);
    for (const attribute of ["role", "aria-label"]) exported.removeAttribute(attribute);
    for (const node of exported.querySelectorAll("[data-kind]")) {
      for (const attribute of ["tabindex", "role", "aria-pressed", "aria-label", "data-kind", "data-index"]) node.removeAttribute(attribute);
      node.classList.remove("selected", "added", "changed");
    }
    return new XMLSerializer().serializeToString(exported);
  }
  async function exportedPng() {
    const scale = Math.min(2, 16000 / Math.max(baseView[2], baseView[3]));
    const image = new Image();
    const url = URL.createObjectURL(new Blob([exportedSvg()], { type: "image/svg+xml" }));
    try {
      image.src = url;
      await image.decode();
      const output = document.createElement("canvas");
      output.width = Math.ceil(baseView[2] * scale);
      output.height = Math.ceil(baseView[3] * scale);
      const context = output.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, output.width, output.height);
      context.drawImage(image, 0, 0, output.width, output.height);
      const blob = await new Promise(resolve => output.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("the image is too large for this browser");
      return { blob, width: output.width, height: output.height };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  clear();
  return { mount, clear, paint, fit, zoom, exportedSvg, exportedPng, get mounted() { return Boolean(svg); } };
}
