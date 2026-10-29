import { mkdir, copyFile } from "node:fs/promises";

await mkdir("dist/vendor", { recursive: true });
for (const name of ["index.html", "styles.css", "app.js", "graph.js", "example.js", "layout-worker.js", "THIRD_PARTY_NOTICES.txt"]) {
  await copyFile(name, `dist/${name}`);
}
await copyFile("node_modules/@viz-js/viz/dist/viz.js", "dist/vendor/viz.js");
