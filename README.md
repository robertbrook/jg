# JSON Graph workbench

A browser-only editor, validator, and interactive preview for [JSON Graph Format v2.1](https://github.com/jsongraph/json-graph-specification).

**Live page:** https://robertbrook.github.io/jg/

## Run locally

Requires Node.js 22+.

```sh
npm ci
npm start      # build, then serve the production site at http://localhost:8000/jg/
npm run dev    # same, and rebuild whenever a source file changes
```

`PORT` and `HOST` override the defaults (`8000`, `127.0.0.1`). `npm run build` writes a self-contained static site to `dist/` that works under any URL subpath; there are no CDN requests at runtime.

You can also open the repository in a **Codespace** or VS Code dev container: dependencies install automatically and the preview opens on port 8000.

## Preview before deployment

- **Locally:** check out the branch and run `npm start`.
- **CI artifact:** every pull request and non-`main` push runs `.github/workflows/ci.yml`, which tests, builds, and uploads the site as the `jg-site` artifact. Download it, unzip it, and serve it with any static server.
- **Hosted PR previews:** `.github/workflows/pages.yml` publishes `main` at `/jg/` and each open same-repository pull request at `/jg/preview/pr-N/`, then comments the link on the PR. Previews are removed on the next deployment after a PR closes. (This requires the workflow to be on `main`; fork PRs are never built.)

The page footer shows when the site was built or last deployed, linking to the source commit.

## Features

- **Editor:** CodeMirror 6 with JSON highlighting, folding, search, inline lint markers, and quick-fix actions. Work is saved in this browser (`localStorage`) and restored on your next visit.
- **Verbose diagnostics:** strict JSON Schema validation against the vendored `json-graph-schema_v2.json` (draft-07), plus duplicate keys, unknown node references, and graph semantics. Each item shows its location, JSON path, expected and found values, the chosen `oneOf` alternative, a source excerpt, and a hint. Filter by severity, expand the panel, or copy a plain-text report.
- **Quick fixes:** rename mistyped properties, move custom fields into `metadata`, correct node references, add missing nodes, unquote booleans, fix trailing or missing commas, close brackets, and more.
- **JSON Graph v1 import:** documents with node arrays can be converted to v2 node maps in one click.
- **Preview:** Graphviz compiled to WebAssembly runs in a worker and loads only when there is something to draw. Hierarchical, force-directed, and circular layouts; hyperedges appear as diamond junctions. Graphs up to 500 nodes render in full; up to 5,000 nodes render in a compact dots-only mode.
- **Linked selection:** selecting a node or edge highlights its source; moving the cursor in the source selects it in the diagram. Double-click a diagram item to edit it.
- **Loading:** paste, open a file, drag and drop a file or link, or load from a URL (GitHub and Gist links are converted to raw URLs; the server must allow CORS). `?url=` links are shareable.
- **Export:** SVG, PNG, and Graphviz DOT.
- Automatic light and dark themes that follow your system setting.

Shortcuts: **Ctrl/Command + Enter** checks immediately; **Ctrl/Command + Shift + F** formats JSON; **Escape** clears the selection.

Documents are never uploaded. Graphviz receives generated DOT only, and its SVG output is sanitized before display.

## Limits

- Documents must be no larger than 2 MiB.
- Graphs above 5,000 nodes or 15,000 connections are validated but not drawn.
- The upstream schema's `oneOf` accepts a graph with neither `edges` nor `hyperedges` under several alternatives, so strict validators reject it. The workbench reports this as a warning, still previews the graph, and offers to add `"edges": []`.

## Tests and deployment

```sh
npm test
npm run build
```

Tests cross-check strict validity against Ajv. The Pages source must be **GitHub Actions**.
