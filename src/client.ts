import { HOST_API_VERSION, parseRealmCatalog, parseRealmDescriptor, type RealmCatalog, type RealmDescriptor, type RealmRoute } from "./contracts";

const MAX_JSON_BYTES = 512 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024;

export type PreparedRealm = Readonly<{ descriptor: RealmDescriptor; catalog: RealmCatalog; route: RealmRoute; js: string; css: string }>;
export type RealmFetcher = (this: typeof globalThis, input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type RealmClientOptions = Readonly<{ fetcher?: RealmFetcher; signal?: AbortSignal; routePath?: string }>;

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = new Uint8Array(typeof value === "string" ? new TextEncoder().encode(value) : value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((entry) => entry.toString(16).padStart(2, "0")).join("");
}

function cancelBestEffort(stream: Pick<ReadableStream<Uint8Array>, "cancel"> | ReadableStreamDefaultReader<Uint8Array> | null) {
  if (!stream) return;
  try { void stream.cancel().catch(() => undefined); } catch { /* preserve the primary protocol error */ }
}

async function boundedBytes(response: Response, maxBytes: number, label: string): Promise<Uint8Array> {
  if (!response.ok) {
    cancelBestEffort(response.body);
    throw new Error(`${label} request failed with ${response.status}`);
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    cancelBestEffort(response.body);
    throw new Error(`${label} exceeds byte limit`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        cancelBestEffort(reader);
        throw new Error(`${label} exceeds byte limit`);
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return combined;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function request(fetcher: RealmFetcher, url: string, init: RequestInit, maxBytes: number, label: string): Promise<Uint8Array> {
  const response = await fetcher.call(globalThis, url, { ...init, redirect: "error" });
  return boundedBytes(response, maxBytes, label);
}

export async function bindAndPrepareRealm(endpoint: string, options: RealmClientOptions = {}): Promise<PreparedRealm> {
  const base = new URL(endpoint);
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("Realm endpoint must use HTTP(S)");
  base.pathname = base.pathname.replace(/\/$/, "") + "/v1/bind";
  base.search = ""; base.hash = "";
  const fetcher = options.fetcher ?? globalThis.fetch;
  const descriptorBytes = await request(fetcher, base.toString(), { method: "POST", signal: options.signal }, MAX_JSON_BYTES, "Realm binding");
  const descriptorText = decodeUtf8(descriptorBytes);
  let descriptorInput: unknown;
  try { descriptorInput = JSON.parse(descriptorText); } catch { throw new Error("Realm descriptor is invalid JSON"); }
  const descriptor = parseRealmDescriptor(descriptorInput, HOST_API_VERSION);
  const headers = { authorization: `Bearer ${descriptor.authority.bindingId}` };
  const catalogBytes = await request(fetcher, descriptor.publication.catalogUrl, { headers, signal: options.signal }, MAX_JSON_BYTES, "Realm catalog");
  if (await sha256Hex(catalogBytes) !== descriptor.publication.catalogSha256) throw new Error("Realm catalog integrity check failed");
  const catalogText = decodeUtf8(catalogBytes);
  let catalogInput: unknown;
  try { catalogInput = JSON.parse(catalogText); } catch { throw new Error("Realm catalog is invalid JSON"); }
  const catalog = parseRealmCatalog(catalogInput);
  if (catalog.realmId !== descriptor.realmId || catalog.generation !== descriptor.publication.generation) throw new Error("Realm catalog authority mismatch");
  const route = options.routePath === undefined
    ? catalog.routes.find((candidate) => candidate.id === catalog.defaultRouteId)!
    : catalog.routes.find((candidate) => candidate.path === options.routePath);
  if (!route) throw new Error(`Realm route not found: ${options.routePath}`);
  for (const capability of route.requiredCapabilities) if (!descriptor.capabilities.includes(capability)) throw new Error("Realm route is not authorized");
  const jsBytes = await request(fetcher, route.component.js.url, { headers, signal: options.signal }, MAX_ARTIFACT_BYTES, "Realm JavaScript artifact");
  if (await sha256Hex(jsBytes) !== route.component.js.sha256) throw new Error("Realm JavaScript artifact integrity check failed");
  const js = decodeUtf8(jsBytes);
  const cssBytes = await request(fetcher, route.component.css.url, { headers, signal: options.signal }, MAX_ARTIFACT_BYTES, "Realm CSS artifact");
  if (await sha256Hex(cssBytes) !== route.component.css.sha256) throw new Error("Realm CSS artifact integrity check failed");
  const css = decodeUtf8(cssBytes);
  return Object.freeze({ descriptor, catalog, route, js, css });
}
