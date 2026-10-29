// Local preview server for dist/ (no dependencies).
//   npm start            build once, then serve http://localhost:8000/jg/
//   npm run dev          rebuild automatically when source files change
// PORT and HOST environment variables override the defaults.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { build } from "./build.mjs";

const port = Number(process.env.PORT ?? 8000);
const host = process.env.HOST ?? "127.0.0.1";
const root = resolve("dist");
// Serve under /jg/ as GitHub Pages does, so relative paths behave the same locally.
const base = "/jg/";
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json"
};

await build();

if (process.argv.includes("--watch")) {
  let timer;
  let building = Promise.resolve();
  const rebuild = name => {
    if (!name || name.startsWith("dist") || name.startsWith("node_modules") || name.startsWith(".git")) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      building = building.then(build).then(
        () => console.log(`Rebuilt after change to ${name}`),
        error => console.error(`Build failed: ${error.message}`)
      );
    }, 100);
  };
  watch(".", rebuild);
  watch("schema", name => rebuild(`schema/${name}`));
}

createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/" || url.pathname === base.slice(0, -1)) {
    response.writeHead(302, { Location: base + url.search }).end();
    return;
  }
  if (!url.pathname.startsWith(base)) {
    response.writeHead(404).end("Not found. The workbench is served at " + base);
    return;
  }
  let path = normalize(join(root, decodeURIComponent(url.pathname.slice(base.length))));
  if (!path.startsWith(root)) {
    response.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(path)).isDirectory()) path = join(path, "index.html");
    const body = await readFile(path);
    response.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(port, host, () => {
  console.log(`JSON Graph workbench: http://${host === "0.0.0.0" ? "localhost" : host}:${port}${base}`);
});
