import { instance } from "./vendor/viz.js";

let viz;
try {
  viz = await instance();
  self.postMessage({ type: "ready", version: viz.graphvizVersion });
} catch (error) {
  self.postMessage({ type: "init-error", message: error.message });
}
self.onmessage = ({ data }) => {
  if (!viz) return;
  const start = performance.now();
  try {
    const result = viz.render(data.dot, { engine: data.engine, format: "svg" });
    self.postMessage({
      type: "result", id: data.id, svg: result.output,
      errors: result.errors, success: result.status === "success",
      duration: performance.now() - start
    });
  } catch (error) {
    self.postMessage({ type: "result", id: data.id, success: false, errors: [{ message: error.message }] });
  }
};
