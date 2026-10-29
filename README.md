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

Merging to `main` deploys the site with `.github/workflows/pages.yml`.

The page footer shows when the site was built or last deployed, linking to the source commit.

## Features

- **Editor:** CodeMirror 6 with JSON highlighting, folding, search, inline lint markers, and quick-fix actions. Work is saved in this browser (`localStorage`) and restored on your next visit.
- **Verbose diagnostics:** strict JSON Schema validation against the vendored `json-graph-schema_v2.json` (draft-07), plus duplicate keys, unknown node references, and graph semantics. A one-line summary heads the list. Each item shows its location, JSON path, expected and found values, the chosen `oneOf` alternative, a source excerpt, and a hint. Expand the panel or copy a plain-text report.
- **Quick fixes:** rename mistyped properties, move custom fields into `metadata`, correct node references, add missing nodes, unquote booleans, fix trailing or missing commas, close brackets, and more. Each fix is one undo step, and an **Undo** button appears in the footer.
- **JSON Graph v1 import:** documents with node arrays can be converted to v2 node maps in one click.
- **Preview:** Graphviz compiled to WebAssembly runs in a worker and loads only when there is something to draw. Hierarchical layout; hyperedges appear as diamond junctions. Graphs up to 500 nodes render in full; up to 5,000 nodes render in a compact dots-only mode.
- **Attributes:** the **Attributes** menu lists the attributes the graph's nodes and edges use (for example `metadata.type`); ticked ones appear as extra lines in the diagram's labels. The Inspector also lists every attribute of the selected node or edge, each with a **Show** toggle. The choice is remembered.
- **Linked selection:** selecting a node or edge highlights its source; moving the cursor in the source selects it in the diagram. Double-click a diagram item to edit it. Tab to a node and use the **arrow keys** to move to the nearest node in that direction, preferring connected nodes.
- **Minimap:** when zoomed in, a minimap shows the visible area; drag it to move around.
- **Changes:** tick **Changes** to highlight nodes and edges added (green) or changed (amber, dashed) since the document was opened or saved, or compare with another file with **Open › Compare with file…**. Removed items are listed in the Inspector.
- **Inspector:** details of the selected item, its connections, and its source object, with URLs as links. The graph overview includes a text **outline** of every node and its targets, for screen readers and large graphs.
- **Loading:** paste, use **Open** for a file or URL, or drag and drop a file or link. GitHub and Gist links are converted to raw URLs; the server must allow CORS. `?url=` links are shareable.
- **Share:** copies a link that contains the whole document, compressed into the URL's `#` fragment, so nothing is uploaded. Links over 8,000 characters come with a warning that some apps cut them off; documents whose links would exceed 100,000 characters must be shared as a file or a `?url=` link instead.
- **Export:** SVG, PNG, or Graphviz DOT from the **Export** menu.
- **Offline:** after the first visit, the workbench works offline and can be installed as an app. A service worker serves from the network first, so new deployments appear on the next load.
- **Examples:** the example menu includes directed and undirected graphs, self-loops and parallel edges, multiple graphs, directed and undirected hyperedges, and a large 800-node graph. Debugging practice documents have schema errors, a JSON syntax error, or use JSON Graph v1.
- **Panes:** on desktop, hide the Document, Graph preview, or Inspector pane; a narrow tab brings it back. The choice is remembered.
- Automatic light and dark themes that follow your system setting.

Shortcuts: **Ctrl/Command + Enter** checks immediately; **Ctrl/Command + Shift + F** formats JSON; **Escape** clears the selection.

Documents are never uploaded. Graphviz receives generated DOT only, and its SVG output is sanitized before display.

## Code layout

| File | Purpose |
| --- | --- |
| `app.js` | State and wiring: loading, saving, settings, panes, and controls |
| `graph.js` | Parsing, validation, diagnostics, quick fixes, diffs, and DOT generation (no DOM; unit tested) |
| `diagnostics-view.js`, `inspector.js` | Diagnostics list and report; Inspector panel |
| `viewer.js` | Diagram: SVG sanitising, pan and zoom, minimap, keyboard navigation, export |
| `layout.js`, `layout-worker.js` | Graphviz WASM worker |
| `loading.js` | URL loading and share links |
| `editor.js` | CodeMirror setup |
| `sw.js` | Offline service worker (asset list filled in by `build.mjs`) |

`build.mjs` bundles `app.js` and its imports into one minified file.

## Limits

- Documents must be no larger than 2 MiB.
- Graphs above 5,000 nodes or 15,000 connections are validated but not drawn.
- The upstream schema's `oneOf` accepts a graph with neither `edges` nor `hyperedges` under several alternatives, so strict validators reject it. The workbench reports this as a warning, still previews the graph, and offers to add `"edges": []`.

## Tests and deployment

```sh
npm test       # unit tests, including an Ajv cross-check and Graphviz rendering
npm run build  # also prints every file's size and fails if one exceeds its gzip budget
npx playwright install chromium && npm run smoke   # browser smoke test of every example and the main controls
```

`npm run smoke` can use an installed Chrome instead: `CHROME_PATH=/usr/bin/google-chrome npm run smoke`. CI runs all three on every pull request. The Pages source must be **GitHub Actions**.
