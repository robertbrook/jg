import { mkdir, copyFile, rm, rename, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { build as bundle } from "esbuild";

const files = ["index.html", "styles.css", "app.js", "graph.js", "schema-validator.js", "example.js", "layout-worker.js", "THIRD_PARTY_NOTICES.txt", "schema/json-graph-schema_v2.json"];

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
  await mkdir(`${stage}/schema`, { recursive: true });
  for (const name of files) await copyFile(name, `${stage}/${name}`);
  await writeFile(`${stage}/index.html`, (await readFile("index.html", "utf8")).replace('<span id="deployed" hidden></span>', buildStamp()));
  await copyFile("node_modules/@viz-js/viz/dist/viz.js", `${stage}/vendor/viz.js`);
  await bundle({ entryPoints: ["editor.js"], bundle: true, format: "esm", minify: true, target: "es2022", outfile: `${stage}/vendor/editor.js`, logLevel: "warning", legalComments: "none" });
  await rm(out, { recursive: true, force: true });
  await rename(stage, out);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await build();
  console.log("Built dist/");
}
