# JSON Graph workbench

A browser-only editor, validator, and interactive preview for [JSON Graph Format v2.1](https://github.com/jsongraph/json-graph-specification).

**Live page:** https://robertbrook.github.io/jg/

## Run locally

Requires Node.js 22+ and Python 3.

```sh
npm ci
npm start
```

Open http://127.0.0.1:8000. `npm run build` creates a self-contained static site in `dist/`; it can be served under any URL subpath. There are no CDN requests or runtime dependencies on remote services. Serve over HTTP(S), rather than opening `index.html` directly, so ES modules and the worker can load.

## Preview and debug

Paste JSON or open a local file. Validation and preview update automatically. Supports `graph` and `graphs`, node maps, directed and undirected edges, self-loops, parallel edges, and directed/undirected hyperedges. Hyperedges appear as diamond junctions. Choose a graph and hierarchical, force-directed, or circular layout.

Diagnostics check field types, required fields, unknown properties, duplicate JSON keys, and missing node references across **all** graphs. Click a diagnostic to select its source range. Custom fields belong in `metadata`. Duplicate edge IDs produce warnings; isolated nodes and weakly connected components appear in the graph summary. Invalid documents clear the preview rather than displaying a stale graph.

Select a node or edge with the mouse or keyboard to inspect its data and jump to its source. Search nodes by ID or label, drag the canvas background to pan, scroll or use buttons to zoom, and choose Fit to restore the complete graph. Save JSON downloads the current source, even if invalid; Export SVG downloads the complete graph without selection/search styling.

Shortcuts: **Ctrl/Command + Enter** updates immediately; **Ctrl/Command + Shift + F** formats JSON; **Escape** clears selection. Tab navigates controls normally. Formatting refuses duplicate keys to avoid dropping data.

Documents are never uploaded, stored remotely, or executed. Graphviz runs as WebAssembly inside a module worker; it receives generated DOT, not arbitrary attributes or executable input. Source is held in memory until downloaded. Leaving with unsaved edits prompts for confirmation.

## Limits

- Supports JSON Graph **v2 node maps**, not v1 node arrays or Falcor's JSON Graph.
- Documents must be no larger than 2 MiB.
- Interactive layouts allow 500 nodes (including hyperedge junctions) and 1,500 connections. Larger documents remain editable and validated.
- A layout exceeding 12 seconds is stopped and can be retried. WASM initialization has a 15-second timeout.
- Validation follows the documented v2.1 structure and reference semantics, not a byte-for-byte implementation of the upstream JSON Schema's overlapping `oneOf` branches. Empty and nodes-only graphs are supported as documented upstream. Mixing edges and hyperedges in one graph is not supported by the format.

## Checks and deployment

```sh
npm test
npm run build
```

The GitHub Actions workflow in `.github/workflows/pages.yml` tests, builds, and deploys `dist/` to GitHub Pages on pushes to `main` or manual dispatch. The repository's Pages source must be **GitHub Actions**. All asset and worker URLs are relative, including the bundled Graphviz WASM, so the `/jg/` project path works without configuration.

Graph layout uses [`@viz-js/viz`](https://github.com/mdaines/viz-js), an MIT-licensed JavaScript wrapper around Graphviz's WebAssembly build. Its npm package includes upstream licensing notices in the distributable.