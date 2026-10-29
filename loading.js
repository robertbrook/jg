import { MAX_SOURCE_BYTES } from "./graph.js";

const MAX_FETCH_MS = 20000;

// GitHub page links return HTML; the raw host serves the file itself with CORS enabled.
export function rawUrl(url) {
  const blob = url.hostname === "github.com" && url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
  if (blob) return new URL(`https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`);
  const gist = url.hostname === "gist.github.com" && url.pathname.match(/^\/([^/]+)\/([0-9a-f]+)\/?$/i);
  if (gist) return new URL(`https://gist.githubusercontent.com/${gist[1]}/${gist[2]}/raw`);
  return url;
}

async function readLimited(response) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_SOURCE_BYTES) throw new Error(`The document is ${(declared / 1048576).toFixed(1)} MiB; the limit is 2 MiB.`);
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SOURCE_BYTES) { reader.cancel(); throw new Error("The document exceeds the 2 MiB limit."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

/** Checks a user-entered URL. Returns { url, target } or throws an Error with a readable message. */
export function parseDocumentUrl(input, page = location) {
  let url;
  try { url = new URL(input.trim(), page.href); } catch { throw new Error("Enter a complete URL, such as https://example.com/graph.json."); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Only http and https URLs can be loaded, not ${url.protocol}`);
  if (page.protocol === "https:" && url.protocol === "http:" && url.hostname !== "localhost") throw new Error("This page is served over HTTPS, so the browser blocks plain HTTP downloads (mixed content). Use an https:// URL.");
  return { url, target: rawUrl(url) };
}

/** Fetches a JSON document with a size limit and timeout. Returns { text, name }. */
export async function fetchDocument(target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_FETCH_MS);
  try {
    const response = await fetch(target, { signal: controller.signal, credentials: "omit", redirect: "follow", headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.5" } });
    if (!response.ok) throw new Error(`The server answered ${response.status}${response.statusText ? ` ${response.statusText}` : ""}. Check that the URL is correct and publicly readable.`);
    if (/text\/html/i.test(response.headers.get("content-type") ?? "")) throw new Error("The server returned an HTML web page, not JSON. Link to the raw file instead (for GitHub, use the Raw button's URL).");
    const text = await readLimited(response);
    const name = decodeURIComponent(target.pathname.split("/").filter(Boolean).pop() || target.hostname) || "remote.json";
    return { text, name };
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`No response after ${MAX_FETCH_MS / 1000} seconds. The server may be slow or unreachable.`);
    if (error instanceof TypeError) throw new Error(`The browser could not read ${target.host}. Most often the server does not allow cross-origin requests (CORS), or the host is unreachable. Raw links from GitHub, GitHub Gists, and most static hosts work; otherwise download the file and open it.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Share links carry the whole document, deflate-compressed and base64url-encoded, in the URL hash (never sent to a server).
const toBase64Url = bytes => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};
const fromBase64Url = text => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
export async function encodeShare(text, name) {
  const payload = new TextEncoder().encode(JSON.stringify({ name, text }));
  return toBase64Url(await pipe(payload, new CompressionStream("deflate-raw")));
}
export async function decodeShare(encoded) {
  const bytes = await pipe(fromBase64Url(encoded), new DecompressionStream("deflate-raw"));
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error("The shared document exceeds the 2 MiB limit.");
  const { name, text } = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof text !== "string") throw new Error("The link does not contain a document.");
  return { text, name: typeof name === "string" && name ? name : "shared.json" };
}
