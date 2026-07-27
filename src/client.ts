import { HOST_API_VERSION, parseRealmCatalog, parseRealmDescriptor, type RealmCatalog, type RealmDescriptor, type RealmRoute } from "./contracts";

const MAX_JSON_BYTES = 512 * 1024;
const MAX_JAVASCRIPT_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_CSS_ARTIFACT_BYTES = 1024 * 1024;
const MAX_BADGE_BYTES = 1024;
const MAX_SERVICE_ACCESS_BYTES = 16 * 1024;

export type RealmChannelHandlers = Readonly<{
  onOpen?(): void;
  onMessage(data: string | ArrayBuffer): void;
  onClose?(code: number, reason: string): void;
  onError?(error: unknown): void;
}>;
export type RealmChannel = Readonly<{
  readonly readyState: number;
  readonly url: string;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
}>;
export type PreparedRealmService = Readonly<{
  endpoint: string;
  request(path: string, init?: RequestInit): Promise<Response>;
  openChannel(path: string, handlers: RealmChannelHandlers): RealmChannel;
}>;
export type PreparedRealm = Readonly<{
  descriptor: RealmDescriptor;
  catalog: RealmCatalog;
  route: RealmRoute;
  services: Readonly<Record<string, PreparedRealmService>>;
  js: string;
  css: string;
}>;
export type RealmFetcher = (this: typeof globalThis, input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type RealmClientOptions = Readonly<{ fetcher?: RealmFetcher; signal?: AbortSignal; routePath?: string }>;
export type RealmBadgeState = Readonly<{ revision: number; count: number }>;
export type RealmBadgeOptions = Readonly<{ fetcher?: RealmFetcher; signal?: AbortSignal }>;
export type BoundRealm = Readonly<{ descriptor: RealmDescriptor }>;

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

function servicePath(path: string): string {
  const queryIndex = path.indexOf("?");
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : path.slice(queryIndex + 1);
  if (!/^\/v1\/[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/.test(pathname)
    || pathname.split("/").some((segment) => segment === "." || segment === "..")
    || !/^[A-Za-z0-9._~!$&'()*+,;=:@/?=%-]*$/.test(query)
    || /%(?![A-Fa-f0-9]{2})/.test(query)
    || path.includes("//")
    || path.includes("#")) {
    throw new Error("Invalid Realm service path");
  }
  return path;
}

function serviceAccessUrl(endpoint: string): string {
  const url = new URL(endpoint);
  url.pathname = "/v1/service-access";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function createPreparedService(
  endpoint: string,
  accessToken: string,
  fetcher: RealmFetcher,
  signal?: AbortSignal,
): PreparedRealmService {
  const publicEndpoint = endpoint.replace(/\/$/u, "");
  return Object.freeze({
    endpoint: publicEndpoint,
    request(path, init = {}) {
      const target = new URL(`${publicEndpoint}${servicePath(path)}`);
      const headers = new Headers(init.headers);
      headers.set("x-klivcore-service-access", accessToken);
      return fetcher.call(globalThis, target, {
        ...init,
        credentials: "same-origin",
        headers,
        redirect: "error",
        signal: init.signal ?? signal,
      });
    },
    openChannel(path, handlers) {
      if (!handlers || typeof handlers !== "object" || typeof handlers.onMessage !== "function") throw new Error("Invalid Realm channel handlers");
      const target = new URL(`${publicEndpoint}${servicePath(path)}`);
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(target);
      const queued: (string | ArrayBuffer)[] = [];
      let queuedBytes = 0;
      let closed = false;
      const normalize = (data: string | ArrayBuffer | Uint8Array): string | ArrayBuffer => {
        if (!(data instanceof Uint8Array)) return data;
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        return copy.buffer;
      };
      const sizeOf = (data: string | ArrayBuffer) => typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
      const channel: RealmChannel = Object.freeze({
        get readyState() { return socket.readyState; },
        get url() { return target.toString(); },
        send(data) {
          const normalized = normalize(data);
          const size = sizeOf(normalized);
          if (size > 512 * 1024) throw new RangeError("Realm channel message exceeds byte limit");
          if (socket.readyState === WebSocket.OPEN) { socket.send(normalized); return; }
          if (socket.readyState !== WebSocket.CONNECTING || closed) throw new Error("Realm channel is not open");
          if (queued.length >= 64 || queuedBytes + size > 512 * 1024) throw new RangeError("Realm channel queue limit reached");
          queued.push(normalized);
          queuedBytes += size;
        },
        close() {
          if (closed) return;
          closed = true;
          queued.length = 0;
          queuedBytes = 0;
          if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close(1000, "Realm publication disposed");
        },
      });
      socket.addEventListener("open", () => {
        if (closed) return;
        socket.send(JSON.stringify({ type: "authorize-service", accessToken }));
        for (const data of queued.splice(0)) socket.send(data);
        queuedBytes = 0;
        try { handlers.onOpen?.(); } catch (error) { handlers.onError?.(error); }
      });
      socket.addEventListener("message", (event) => {
        if (closed) return;
        const data = typeof event.data === "string" || event.data instanceof ArrayBuffer ? event.data : String(event.data);
        try { handlers.onMessage(data); } catch (error) { handlers.onError?.(error); }
      });
      socket.addEventListener("error", (event) => { if (!closed) handlers.onError?.(event); });
      socket.addEventListener("close", (event) => {
        try { handlers.onClose?.(event.code, event.reason); } catch (error) { handlers.onError?.(error); }
      });
      return channel;
    },
  });
}

async function request(fetcher: RealmFetcher, url: string, init: RequestInit, maxBytes: number, label: string): Promise<Uint8Array> {
  const response = await fetcher.call(globalThis, url, { ...init, redirect: "error" });
  return boundedBytes(response, maxBytes, label);
}

function badgeUrl(endpoint: string, suffix = ""): string {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Realm endpoint must use HTTP(S)");
  url.pathname = url.pathname.replace(/\/$/, "") + `/v1/badge${suffix}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function parseBadgeState(bytes: Uint8Array): RealmBadgeState {
  let input: unknown;
  try { input = JSON.parse(decodeUtf8(bytes)); } catch { throw new Error("Realm badge state is invalid JSON"); }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Realm badge state is invalid");
  const record = input as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "count,revision"
    || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0
    || !Number.isSafeInteger(record.count) || (record.count as number) < 0 || (record.count as number) > 999) {
    throw new Error("Realm badge state is invalid");
  }
  return Object.freeze({ revision: record.revision as number, count: record.count as number });
}

export async function readRealmBadge(endpoint: string, bindingId: string, options: RealmBadgeOptions = {}): Promise<RealmBadgeState> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const bytes = await request(fetcher, badgeUrl(endpoint), {
    headers: { authorization: `Bearer ${bindingId}` },
    signal: options.signal,
  }, MAX_BADGE_BYTES, "Realm badge");
  return parseBadgeState(bytes);
}

export async function writeRealmBadge(endpoint: string, bindingId: string, count: number, options: RealmBadgeOptions = {}): Promise<RealmBadgeState> {
  if (!Number.isSafeInteger(count) || count < 0 || count > 999) throw new Error("Realm badge count must be an integer from 0 to 999");
  const fetcher = options.fetcher ?? globalThis.fetch;
  const bytes = await request(fetcher, badgeUrl(endpoint, `/${count}`), {
    method: "POST",
    headers: { authorization: `Bearer ${bindingId}` },
    signal: options.signal,
  }, MAX_BADGE_BYTES, "Realm badge");
  return parseBadgeState(bytes);
}

export async function bindRealm(endpoint: string, options: Omit<RealmClientOptions, "routePath"> = {}): Promise<BoundRealm> {
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
  return Object.freeze({ descriptor });
}

export async function bindAndPrepareRealm(endpoint: string, options: RealmClientOptions = {}): Promise<PreparedRealm> {
  const { descriptor } = await bindRealm(endpoint, options);
  const fetcher = options.fetcher ?? globalThis.fetch;
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
  let services: Readonly<Record<string, PreparedRealmService>> = Object.freeze({});
  if (route.services.length > 0) {
    const accessBytes = await request(fetcher, serviceAccessUrl(endpoint), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ routeId: route.id }),
      signal: options.signal,
    }, MAX_SERVICE_ACCESS_BYTES, "Realm service access");
    let accessInput: unknown;
    try { accessInput = JSON.parse(decodeUtf8(accessBytes)); } catch { throw new Error("Realm service access is invalid JSON"); }
    const access = accessInput && typeof accessInput === "object" && !Array.isArray(accessInput)
      ? accessInput as Record<string, unknown> : undefined;
    if (!access || Object.keys(access).join(",") !== "services" || !Array.isArray(access.services)
      || access.services.length !== route.services.length) throw new Error("Realm service access is invalid");
    const entries = access.services.map((entry, index): readonly [string, PreparedRealmService] => {
      const service = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined;
      const expected = route.services[index];
      if (!service || Object.keys(service).sort().join(",") !== "accessToken,endpoint,id"
        || service.id !== expected?.id || service.endpoint !== expected.endpoint
        || typeof service.accessToken !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(service.accessToken)) {
        throw new Error("Realm service access is invalid");
      }
      const absoluteEndpoint = new URL(service.endpoint, new URL(endpoint).origin).toString().replace(/\/$/u, "");
      return [service.id as string, createPreparedService(absoluteEndpoint, service.accessToken, fetcher, options.signal)] as const;
    });
    services = Object.freeze(Object.fromEntries(entries));
  }
  const jsBytes = await request(fetcher, route.component.js.url, { headers, signal: options.signal }, MAX_JAVASCRIPT_ARTIFACT_BYTES, "Realm JavaScript artifact");
  if (await sha256Hex(jsBytes) !== route.component.js.sha256) throw new Error("Realm JavaScript artifact integrity check failed");
  const js = decodeUtf8(jsBytes);
  const cssBytes = await request(fetcher, route.component.css.url, { headers, signal: options.signal }, MAX_CSS_ARTIFACT_BYTES, "Realm CSS artifact");
  if (await sha256Hex(cssBytes) !== route.component.css.sha256) throw new Error("Realm CSS artifact integrity check failed");
  const css = decodeUtf8(cssBytes);
  return Object.freeze({ descriptor, catalog, route, services, js, css });
}
