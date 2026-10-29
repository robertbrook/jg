// CodeMirror 6 wrapper. Bundled to dist/vendor/editor.js by build.mjs (esbuild).
import { basicSetup } from "codemirror";
import { EditorView, keymap, Decoration } from "@codemirror/view";
import { EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { json } from "@codemirror/lang-json";
import { setDiagnostics, lintGutter } from "@codemirror/lint";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

// Colours come from CSS custom properties so the editor follows light and dark mode automatically.
const highlight = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--syntax-key)" },
  { tag: tags.string, color: "var(--syntax-string)" },
  { tag: tags.number, color: "var(--syntax-number)" },
  { tag: [tags.bool, tags.null], color: "var(--syntax-literal)" },
  { tag: [tags.punctuation, tags.separator, tags.brace, tags.squareBracket], color: "var(--muted)" }
]);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "Canvas", color: "CanvasText" },
  ".cm-scroller": { fontFamily: "monospace", lineHeight: "1.6" },
  ".cm-gutters": { backgroundColor: "var(--soft)", color: "var(--muted)", borderRight: "1px solid var(--rule)" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--active-line)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--selection) !important" },
  ".cm-cursor": { borderLeftColor: "CanvasText" },
  ".cm-linked": { backgroundColor: "var(--linked)", outline: "1px solid var(--accent)" },
  ".cm-tooltip": { backgroundColor: "Canvas", color: "CanvasText", border: "1px solid var(--rule)" },
  ".cm-diagnostic": { whiteSpace: "pre-wrap", maxWidth: "460px" },
  ".cm-diagnosticAction": { backgroundColor: "var(--accent)", color: "Canvas", borderRadius: "3px" },
  ".cm-panels": { backgroundColor: "var(--soft)", color: "CanvasText" },
  ".cm-searchMatch": { backgroundColor: "var(--search-match)" }
});

const setLinked = StateEffect.define();
const linkedField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setLinked)) {
      const { from, to } = effect.value ?? {};
      value = effect.value && to > from ? Decoration.set([Decoration.mark({ class: "cm-linked" }).range(from, to)]) : Decoration.none;
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field)
});

/**
 * @param {HTMLElement} parent
 * @param {{ label: string, onChange(): void, onCursor(info, byUser): void, onRun(): void, onFormat(): void, onFix(fix): void }} hooks
 */
export function createEditor(parent, hooks) {
  let silent = false;
  const extensions = [
    Prec.highest(keymap.of([
          { key: "Mod-Enter", run: () => { hooks.onRun(); return true; } },
          { key: "Shift-Mod-f", run: () => { hooks.onFormat(); return true; } }
        ])),
        basicSetup,
        json(),
        syntaxHighlighting(highlight),
        lintGutter(),
        linkedField,
        theme,
        EditorState.tabSize.of(2),
        EditorView.contentAttributes.of({ "aria-label": hooks.label, spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !silent) hooks.onChange();
          if (update.selectionSet || update.docChanged) {
            const byUser = update.transactions.some(transaction => transaction.isUserEvent("select") || transaction.isUserEvent("input") || transaction.isUserEvent("delete"));
            hooks.onCursor(cursorInfo(update.state), byUser);
          }
        })
  ];
  const view = new EditorView({ parent, state: EditorState.create({ doc: "", extensions }) });
  const cursorInfo = state => {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    return { position: head, line: line.number, column: head - line.from + 1 };
  };
  const clamp = position => Math.max(0, Math.min(position, view.state.doc.length));
  return {
    view,
    get value() { return view.state.doc.toString(); },
    /** Replaces the whole document. silent: true skips onChange (used when loading). */
    setValue(text, { silent: quiet = true, keepHistory = false } = {}) {
      silent = quiet;
      if (keepHistory) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 }, scrollIntoView: true });
      else view.setState(EditorState.create({ doc: text, extensions }));
      silent = false;
    },
    applyEdits(edits) {
      view.dispatch({ changes: edits.map(({ from, to, insert }) => ({ from, to, insert })), userEvent: "input.fix", scrollIntoView: true });
    },
    select(from, to = from, { focus = true } = {}) {
      view.dispatch({ selection: { anchor: clamp(from), head: clamp(to) }, effects: EditorView.scrollIntoView(clamp(from), { y: "center" }) });
      if (focus) view.focus();
    },
    link(range) {
      const effects = [setLinked.of(range ? { from: clamp(range.from), to: clamp(range.to) } : null)];
      if (range) effects.push(EditorView.scrollIntoView(clamp(range.from), { y: "nearest", yMargin: 40 }));
      view.dispatch({ effects });
    },
    setDiagnostics(items) {
      view.dispatch(setDiagnostics(view.state, items.map(item => ({
        from: clamp(item.from), to: clamp(Math.max(item.to, item.from)), severity: item.severity, message: item.message,
        actions: (item.fixes ?? []).map(fix => ({ name: fix.label, apply: () => hooks.onFix(fix) }))
      }))));
    },
    focus() { view.focus(); },
    cursor() { return cursorInfo(view.state); }
  };
}
