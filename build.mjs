import { mkdir, copyFile, rm, rename, readFile, writeFile, readdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { build as bundle } from "esbuild";

// app.js and its modules (including CodeMirror and the schema) are bundled into one minified file.
const files = ["index.html", "styles.css", "layout-worker.js", "THIRD_PARTY_NOTICES.txt", "manifest.webmanifest", "icon.svg"];

const escape = text => text.replace(/[&<>"]/g, char => `&#${char.charCodeAt(0)};`);
function commit() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; }
}
// DEPLOY=1 (set by the Pages workflow) labels the stamp "Last deployed"; other builds say "Built".
function buildStamp(now = new Date()) {
  const iso = now.toISOString();
  const sha = commit();
  const repo = process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}` : "https://github.com/robertbrook/jg";
  const link = /^[0-9a-f]{40}$/.test(sha) ? ` · <a href="${escape(`${repo}/commit/${sha}`)}">${sha.slice(0, 7)}</a>` : "";
  return `<span id="deployed">${process.env.DEPLOY ? "Last deployed" : "Built"} <time datetime="${iso}">${iso.slice(0, 16).replace("T", " ")} UTC</time>${link}</span>`;
}

// Builds into a staging folder and swaps it in, so a running preview server never sees a half-built site.
export async function build(out = "dist") {
  const stage = `${out}.next`;
  await rm(stage, { recursive: true, force: true });
  await mkdir(`${stage}/vendor`, { recursive: true });
  for (const name of files) await copyFile(name, `${stage}/${name}`);
  await writeFile(`${stage}/index.html`, (await readFile("index.html", "utf8")).replace('<span id="deployed" hidden></span>', buildStamp()));
  await copyFile("node_modules/@viz-js/viz/dist/viz.js", `${stage}/vendor/viz.js`);
  await bundle({ entryPoints: ["app.js"], bundle: true, format: "esm", minify: true, target: "es2022", outfile: `${stage}/app.js`, logLevel: "warning", legalComments: "none" });
  // Precache everything except the large WASM bundle, which the service worker caches on first use.
  const precache = ["./", ...(await readdir(stage, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile() && !["index.html", "vendor/viz.js"].includes(relative(entry, stage)))
    .map(entry => `./${relative(entry, stage)}`)];
  const sw = (await readFile("sw.js", "utf8"))
    .replace('const VERSION = "dev";', `const VERSION = ${JSON.stringify(new Date().toISOString())};`)
    .replace("const ASSETS = [];", `const ASSETS = ${JSON.stringify(precache)};`);
  await writeFile(`${stage}/sw.js`, sw);
  await rm(out, { recursive: true, force: true });
  await rename(stage, out);
}

const relative = (entry, root) => `${entry.parentPath ?? entry.path}/${entry.name}`.slice(root.length + 1).replaceAll("\\", "/");

/** Raw and gzip size of each file, largest first, so bundle growth is visible in every build. */
export async function sizes(out = "dist") {
  const result = [];
  for (const entry of await readdir(out, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const body = await readFile(`${entry.parentPath ?? entry.path}/${entry.name}`);
    result.push({ file: relative(entry, out), bytes: body.length, gzip: gzipSync(body).length });
  }
  return result.sort((a, b) => b.gzip - a.gzip);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await build();
  const kb = bytes => `${(bytes / 1024).toFixed(1)} KB`.padStart(10);
  console.log("Built dist/\n      raw      gzip  file");
  for (const { file, bytes, gzip } of await sizes()) console.log(`${kb(bytes)}${kb(gzip)}  ${file}${file === "vendor/viz.js" ? " (loaded only when a graph is drawn)" : ""}`);
}
