// Graphviz WASM runs in a worker so layout never blocks the editor. The worker (and its WASM) is only fetched on first use.
export function createLayoutEngine({ onStarting, onReady, onResult, onFailure }) {
  let worker = null;
  let ready = false;
  let pending = false;
  let timer;

  function fail(message) {
    clearTimeout(timer);
    worker?.terminate();
    worker = null;
    ready = false;
    pending = false;
    onFailure(message);
  }
  function start() {
    worker?.terminate();
    clearTimeout(timer);
    ready = false;
    pending = false;
    onStarting();
    try {
      worker = new Worker(new URL("./layout-worker.js", import.meta.url), { type: "module" });
    } catch (error) {
      fail(`Cannot start the layout worker: ${error.message}. Serve this page over HTTP, then retry.`);
      return;
    }
    timer = setTimeout(() => fail("The WASM engine took too long to start. Retry the layout engine."), 15000);
    worker.onerror = event => {
      event.preventDefault();
      fail(`Layout worker failed: ${event.message || "could not load the WASM bundle"}. Retry the layout engine.`);
    };
    worker.onmessage = ({ data }) => {
      if (data.type === "init-error") { fail(`Cannot initialize WASM: ${data.message}. Retry the layout engine.`); return; }
      if (data.type === "ready") { clearTimeout(timer); ready = true; onReady(data.version); return; }
      if (data.type !== "result") return;
      pending = false;
      clearTimeout(timer);
      onResult(data);
    };
  }
  /** Queues a layout. Returns false when the engine is still starting; onReady fires when it can be retried. */
  function layout(id, dot, engine, limit) {
    if (!worker) { start(); return false; }
    if (!ready) return false;
    // A layout is still running: restart the worker rather than queue behind it.
    if (pending) { start(); return false; }
    pending = true;
    timer = setTimeout(() => fail(`Layout exceeded ${limit / 1000} seconds. Choose a simpler graph, then retry the engine.`), limit);
    worker.postMessage({ id, dot, engine });
    return true;
  }
  return { start, layout, get ready() { return ready; } };
}
