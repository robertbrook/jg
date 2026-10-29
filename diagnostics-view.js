import { humanPath, SCHEMA } from "./graph.js";
import { $, element, button, plural } from "./ui.js";

const SEVERITY_LABEL = { error: "Error", warning: "Warning", info: "Info" };
const MAX_RENDERED = 200;

function counts(analysis) {
  const result = { error: 0, warning: 0, info: 0 };
  for (const item of analysis.diagnostics) result[item.severity]++;
  return result;
}
const SCHEMA_STATE = { "not-run": ["state-invalid", "Not valid JSON"], valid: ["state-valid", "Valid"], ambiguous: ["state-ambiguous", "Valid (ambiguous oneOf)"], invalid: ["state-invalid", "Invalid"] };

function excerpt(diagnostic, text) {
  if (!diagnostic.line) return null;
  const lines = text.split("\n");
  const index = diagnostic.line - 1;
  if (index >= lines.length) return null;
  const width = String(Math.min(lines.length, index + 2)).length;
  const column = Math.max(0, (diagnostic.column ?? 1) - 1);
  // Keep very long lines readable by windowing around the column.
  const offset = Math.max(0, Math.min(column - 30, lines[index].length - 90));
  const clip = line => (offset ? "…" : "") + line.slice(offset, offset + 100) + (line.length > offset + 100 ? "…" : "");
  const block = element("pre", undefined, "excerpt");
  if (index > 0) block.append(`${String(index).padStart(width)} │ ${clip(lines[index - 1])}\n`);
  block.append(`${String(index + 1).padStart(width)} │ ${clip(lines[index])}\n`);
  const span = Math.max(1, Math.min(diagnostic.length || 1, lines[index].length - column || 1, 60));
  block.append(element("span", `${" ".repeat(width)} │ ${" ".repeat(column - offset + (offset ? 1 : 0))}${"^".repeat(span)}`, "caret"));
  if (index + 1 < lines.length) block.append(`\n${String(index + 2).padStart(width)} │ ${clip(lines[index + 1])}`);
  return block;
}
function detailRows(diagnostic, document) {
  return [
    ["Expected", diagnostic.expected],
    ["Found", diagnostic.found],
    ["Path", diagnostic.path !== undefined ? humanPath(diagnostic.path, document) : undefined],
    ["JSON pointer", diagnostic.path !== undefined ? diagnostic.path || "(root)" : undefined],
    ["Schema rule", diagnostic.schemaPath],
    ["Code", diagnostic.code]
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
}
function renderDiagnostic(diagnostic, analysis, text, { onJump, onFix }) {
  const item = element("article", undefined, `diagnostic ${diagnostic.severity}`);
  const head = element("div", undefined, "diagnostic-head");
  head.append(element("span", SEVERITY_LABEL[diagnostic.severity], "badge"), element("span", [diagnostic.category, diagnostic.keyword].filter(Boolean).join(" · "), "diagnostic-meta"));
  const title = button(diagnostic.title ?? diagnostic.message, () => onJump(diagnostic.path, diagnostic.start, diagnostic.length), "diagnostic-title");
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
    for (const fix of diagnostic.fixes) actions.append(button(fix.label, () => onFix(fix), "fix"));
    item.append(actions);
  }
  const rows = detailRows(diagnostic, analysis.document);
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
  const snippet = excerpt(diagnostic, text);
  if (snippet) item.append(snippet);
  return item;
}

/** One summary line in the heading, then every diagnostic in full. */
export function showDiagnostics(analysis, text, handlers) {
  const total = counts(analysis);
  const { summary } = analysis;
  const [stateClass, stateText] = SCHEMA_STATE[summary.schema];
  const parts = analysis.diagnostics.length
    ? [plural(total.error, "error"), plural(total.warning, "warning"), total.info ? `${total.info} info` : ""]
    : [plural(summary.graphs, "graph"), plural(summary.nodes, "node"), plural(summary.links, "link")];
  $("diagnostic-count").textContent = [stateText, ...parts].filter(Boolean).join(" · ");
  $("diagnostic-count").className = stateClass;
  const list = $("diagnostics");
  list.replaceChildren();
  if (!analysis.diagnostics.length) {
    list.append(element("p", "All checks passed: JSON syntax, the official schema, duplicate keys, and node references.", "healthy"));
    return;
  }
  for (const diagnostic of analysis.diagnostics.slice(0, MAX_RENDERED)) list.append(renderDiagnostic(diagnostic, analysis, text, handlers));
  if (analysis.diagnostics.length > MAX_RENDERED) list.append(element("p", `Showing the first ${MAX_RENDERED} of ${analysis.diagnostics.length}. Copy the report to see all of them.`, "diagnostics-more"));
}

export function diagnosticReport(analysis, filename) {
  const total = counts(analysis);
  const lines = [
    `JSON Graph diagnostics — ${filename}`,
    `Schema: ${SCHEMA.file} (${SCHEMA.dialect}) — ${SCHEMA_STATE[analysis.summary.schema][1]}`,
    `Totals: ${plural(total.error, "error")}, ${plural(total.warning, "warning")}, ${total.info} info`,
    ""
  ];
  analysis.diagnostics.forEach((diagnostic, index) => {
    lines.push(`${index + 1}. [${SEVERITY_LABEL[diagnostic.severity]}] ${diagnostic.title ?? diagnostic.message}${diagnostic.line ? ` (Ln ${diagnostic.line}, Col ${diagnostic.column})` : ""}`);
    if (diagnostic.title && diagnostic.message) lines.push(`   ${diagnostic.message}`);
    for (const [term, value] of detailRows(diagnostic, analysis.document)) lines.push(`   ${term}: ${value}`);
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
