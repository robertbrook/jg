// Browser smoke test: loads every example in Chromium and checks the preview, diagnostics, and main controls.
//   npm run smoke                       (after: npx playwright install chromium)
//   CHROME_PATH=/usr/bin/google-chrome npm run smoke
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { examples } from "../example.js";

const port = 8123;
const base = `http://127.0.0.1:${port}/jg/`;
const server = spawn(process.execPath, ["serve.mjs"], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve, reject) => {
  server.stdout.on("data", chunk => { if (String(chunk).includes("http://")) resolve(); });
  server.on("exit", code => reject(new Error(`Server exited with ${code}`)));
});

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const failures = [];
const check = async (name, run) => {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  try {
    await page.goto(base);
    await run(page);
    assert.deepEqual(errors, [], "console errors");
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n  ${error.message.split("\n").join("\n  ")}`);
  } finally {
    await context.close();
  }
};

for (const example of examples) {
  await check(`example: ${example.name}`, async page => {
    await page.selectOption("#example", example.id);
    await page.waitForFunction(() => !document.querySelector("#diagnostic-count").textContent.includes("Checking"));
    const summary = await page.textContent("#diagnostic-count");
    if (example.kind === "valid") {
      assert.match(summary, /^Valid/, "valid example passes validation");
      await page.waitForSelector("#canvas svg [data-kind='node']", { timeout: 30000 });
    } else {
      assert.ok(await page.locator("#diagnostics .diagnostic").count() > 0, "debugging example shows diagnostics");
    }
  });
}

await check("select, keyboard navigation, inspector", async page => {
  await page.waitForSelector("#canvas svg [data-kind='node']", { timeout: 30000 });
  const first = page.locator("#canvas [data-kind='node']").first();
  await first.click();
  assert.equal(await page.textContent("#inspector .kind"), "Node");
  await first.focus();
  const before = await page.textContent("#inspector h3");
  for (const key of ["ArrowDown", "ArrowRight", "ArrowLeft", "ArrowUp"]) {
    await page.keyboard.press(key);
    if (await page.textContent("#inspector h3") !== before) break;
  }
  assert.notEqual(await page.textContent("#inspector h3"), before, "arrow keys move to another node");
  await page.keyboard.press("Escape");
  assert.equal(await page.textContent("#inspector .kind"), "Graph overview");
  assert.ok(await page.locator("#inspector .outline li").count() > 0, "outline lists nodes");
});

await check("zoom shows the minimap", async page => {
  await page.waitForSelector("#canvas svg [data-kind='node']", { timeout: 30000 });
  assert.equal(await page.isVisible("#minimap"), false);
  await page.click("#zoom-in");
  assert.equal(await page.isVisible("#minimap"), true);
  await page.click("#fit");
  assert.equal(await page.isVisible("#minimap"), false);
});

await check("attributes appear in labels", async page => {
  await page.waitForSelector("#canvas svg [data-kind='node']", { timeout: 30000 });
  await page.click("#attributes-menu summary");
  await page.locator("#attribute-options input[data-path='node:id']").check();
  await page.waitForFunction(() => document.querySelector("#canvas svg")?.textContent.includes("id: "), null, { timeout: 30000 });
});

await check("inspector attribute toggle shows the attribute in the diagram", async page => {
  await page.waitForSelector("#canvas svg [data-kind='node']", { timeout: 30000 });
  await page.locator("#canvas [data-kind='node']").first().click();
  const toggle = page.locator("#inspector table.attributes input[aria-label='Show id in the diagram']");
  await toggle.check();
  await page.waitForFunction(() => document.querySelector("#canvas svg")?.textContent.includes("id: "), null, { timeout: 30000 });
  assert.equal(await page.locator("#attribute-options input[data-path='node:id']").isChecked(), true, "menu reflects the toggle");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Show id in the diagram", "focus is kept");
});

await check("quick fix and undo", async page => {
  const debug = examples.find(example => example.kind === "debug");
  await page.selectOption("#example", debug.id);
  const fix = page.locator("#diagnostics .fix").first();
  if (!await fix.count()) return;
  const text = await page.evaluate(() => document.querySelector(".cm-content").textContent);
  await fix.click();
  await page.waitForSelector("#undo:not([hidden])");
  await page.click("#undo");
  await page.waitForFunction(original => document.querySelector(".cm-content").textContent === original, text);
});

await check("share link round trip", async page => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.waitForSelector("#canvas svg [data-kind='node']", { timeout: 30000 });
  const original = await page.evaluate(() => document.querySelector(".cm-content").textContent);
  await page.click("#share");
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("Share link copied"));
  const link = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(link, /#doc=[\w-]+$/);
  await page.evaluate(() => localStorage.clear());
  await page.goto("about:blank");
  await page.goto(link);
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("share link"));
  assert.equal(await page.evaluate(() => document.querySelector(".cm-content").textContent), original);
  assert.equal(new URL(page.url()).hash, "", "hash is cleared after opening");
});

await check("changes highlight edits", async page => {
  await page.waitForSelector("#canvas svg [data-kind='node']", { timeout: 30000 });
  await page.check("#changes");
  assert.match(await page.textContent("#status"), /changes since/i);
  assert.ok(await page.locator("#inspector .changes").count() === 1, "inspector lists changes");
});

await browser.close();
server.kill();
if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
console.log("\nAll smoke checks passed.");
