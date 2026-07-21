import { HOST_API_VERSION, parseRealmCatalog, parseRealmDescriptor, type RealmCatalog, type RealmDescriptor, type RealmRoute } from "./contracts";

const MAX_JSON_BYTES = 512 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024;

export type PreparedRealm = Readonly<{ descriptor: RealmDescriptor; catalog: RealmCatalog; route: RealmRoute; js: string; css: string }>;
export type RealmFetcher = (this: typeof globalThis, input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type RealmClientOptions = Readonly<{ fetcher?: RealmFetcher; signal?: AbortSignal }>;

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((entry) => entry.toString(16).padStart(2, "0")).join("");
}

async function boundedText(response: Response, maxBytes: number, label: string): Promise<string> {
  if (!response.ok) throw new Error(`${label} request failed with ${response.status}`);
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    void response.body?.cancel();
    throw new Error(`${label} exceeds byte limit`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        void reader.cancel();
        throw new Error(`${label} exceeds byte limit`);
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(combined);
}

async function request(fetcher: RealmFetcher, url: string, init: RequestInit, maxBytes: number, label: string): Promise<string> {
  const response = await fetcher.call(globalThis, url, { ...init, redirect: "error" });
  return boundedText(response, maxBytes, label);
}

export async function bindAndPrepareRealm(endpoint: string, options: RealmClientOptions = {}): Promise<PreparedRealm> {
  const base = new URL(endpoint);
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("Realm endpoint must use HTTP(S)");
  base.pathname = base.pathname.replace(/\/$/, "") + "/v1/bind";
  base.search = ""; base.hash = "";
  const fetcher = options.fetcher ?? globalThis.fetch;
  const descriptorText = await request(fetcher, base.toString(), { method: "POST", signal: options.signal }, MAX_JSON_BYTES, "Realm binding");
  let descriptorInput: unknown;
  try { descriptorInput = JSON.parse(descriptorText); } catch { throw new Error("Realm descriptor is invalid JSON"); }
  const descriptor = parseRealmDescriptor(descriptorInput, HOST_API_VERSION);
  const headers = { authorization: `Bearer ${descriptor.authority.bindingId}` };
  const catalogText = await request(fetcher, descriptor.publication.catalogUrl, { headers, signal: options.signal }, MAX_JSON_BYTES, "Realm catalog");
  if (await sha256Hex(catalogText) !== descriptor.publication.catalogSha256) throw new Error("Realm catalog integrity check failed");
  let catalogInput: unknown;
  try { catalogInput = JSON.parse(catalogText); } catch { throw new Error("Realm catalog is invalid JSON"); }
  const catalog = parseRealmCatalog(catalogInput);
  if (catalog.realmId !== descriptor.realmId || catalog.generation !== descriptor.publication.generation) throw new Error("Realm catalog authority mismatch");
  const route = catalog.routes.find((candidate) => candidate.id === catalog.defaultRouteId)!;
  for (const capability of route.requiredCapabilities) if (!descriptor.capabilities.includes(capability)) throw new Error("Default route is not authorized");
  const js = await request(fetcher, route.component.js.url, { headers, signal: options.signal }, MAX_ARTIFACT_BYTES, "Realm JavaScript artifact");
  if (await sha256Hex(js) !== route.component.js.sha256) throw new Error("Realm JavaScript artifact integrity check failed");
  const css = await request(fetcher, route.component.css.url, { headers, signal: options.signal }, MAX_ARTIFACT_BYTES, "Realm CSS artifact");
  if (await sha256Hex(css) !== route.component.css.sha256) throw new Error("Realm CSS artifact integrity check failed");
  return Object.freeze({ descriptor, catalog, route, js, css });
}
