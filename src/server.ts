import { HOST_API_VERSION, PROTOCOL_VERSION, SCHEMA_VERSION, parseRealmCatalog, parseRealmDescriptor } from "./contracts";
import { sha256Hex } from "./client";
import { createPasskeyAuth, parseRealmBranding, type PasskeyAuth, type RealmBranding, type RealmSession } from "./passkey-auth";

export { createPasskeyAuth };

export type RealmAppPublication = Readonly<{
  respond(request: Request, fallbackToIndex: boolean | undefined, branding: RealmBranding): Response | undefined;
}>;

export type RealmGatewayServiceChannel = Readonly<{
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}>;

export type RealmGatewayServiceSession = Readonly<{
  message(data: string | Uint8Array): void;
  close?(): void;
}>;

export type RealmGatewayService = Readonly<{
  path: string;
  requiredCapabilities: readonly string[];
  maxMessageBytes: number;
  connect(channel: RealmGatewayServiceChannel): RealmGatewayServiceSession;
  handleRequest?(request: Request, url: URL): Response | Promise<Response>;
}>;

export type RealmGatewayRouteConfig = Readonly<{
  id: string;
  path: string;
  title: string;
  requiredCapabilities: readonly string[];
  componentId: string;
  js: string;
  css: string;
}>;

export type RealmGatewayConfig = Readonly<{
  branding: RealmBranding;
  hostname?: string;
  port: number;
  realmId: string;
  name: string;
  authorityEpoch: string;
  generation: string;
  capabilities: readonly string[];
  publicBindingCapabilities?: readonly string[];
  maxPublicBindings?: number;
  maxTrustedBindings?: number;
  appV2?: RealmAppPublication;
  auth?: PasskeyAuth;
  services?: readonly RealmGatewayService[];
  defaultRoute: RealmGatewayRouteConfig;
  routes?: readonly RealmGatewayRouteConfig[];
}>;

export type RunningRealmGateway = Readonly<{
  endpoint: string;
  issueBinding(capabilities: readonly string[]): Readonly<{ bindingId: string; capabilities: readonly string[] }>;
  revokeBinding(bindingId: string): boolean;
  issueRegistrationUrl(options?: Readonly<{ ttlMs?: number }>): string;
  stop(): void;
}>;

const corsHeaders = {
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-origin": "*",
};

type RealmSocketData =
  | { authenticated: boolean; bindingId?: string; kind: "notifications" }
  | { authenticated: boolean; bindingId?: string; kind: "service"; service: RealmGatewayService; session?: RealmGatewayServiceSession };

type BoundSocket = Readonly<{ close(code?: number, reason?: string): void }>;

function jsonResponse(value: unknown, status = 200, extraHeaders: HeadersInit = corsHeaders) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...extraHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

function withHeaders(response: Response, extraHeaders: Readonly<Record<string, string>>): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extraHeaders)) if (!headers.has(name)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

type PublicBinding = Readonly<{
  capabilities: ReadonlySet<string>;
  sessionId?: string;
  expiresAt?: number;
}>;

export function createRealmGateway(config: RealmGatewayConfig): RunningRealmGateway {
  const branding = parseRealmBranding(config.branding);
  const responseHeaders = config.auth ? {} : corsHeaders;
  const json = (value: unknown, status = 200) => jsonResponse(value, status, responseHeaders);
  const configuredCapabilities = new Set(config.capabilities);
  const publicBindingCapabilities = [...(config.publicBindingCapabilities ?? config.capabilities)];
  const publicBindingCapabilitySet = new Set(publicBindingCapabilities);
  const maxPublicBindings = config.maxPublicBindings ?? 256;
  const maxTrustedBindings = config.maxTrustedBindings ?? 256;
  const publicBindings = new Map<string, PublicBinding>();
  const trustedBindings = new Map<string, ReadonlySet<string>>();
  const activeBindingSockets = new Map<string, Set<BoundSocket>>();
  const routeConfigs = [config.defaultRoute, ...(config.routes ?? [])];
  const services = [...(config.services ?? [])];
  const reservedServicePaths = ["/v1/bind", "/v1/catalog", "/v1/badge", "/v1/notifications"];
  if (publicBindingCapabilities.some((capability) => !configuredCapabilities.has(capability))) {
    throw new TypeError("public binding capabilities must be published by the Realm");
  }
  if (!Number.isSafeInteger(maxPublicBindings) || maxPublicBindings < 1 || maxPublicBindings > 4_096
    || !Number.isSafeInteger(maxTrustedBindings) || maxTrustedBindings < 1 || maxTrustedBindings > 4_096) {
    throw new TypeError("Realm binding limits are invalid");
  }
  for (const [index, service] of services.entries()) {
    if (!/^\/v1\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(service.path)
      || reservedServicePaths.some((path) => service.path === path || service.path.startsWith(`${path}/`))) {
      throw new TypeError(`Realm service ${index} path is invalid or reserved`);
    }
    if (!Number.isSafeInteger(service.maxMessageBytes) || service.maxMessageBytes < 1 || service.maxMessageBytes > 512 * 1024) {
      throw new TypeError(`Realm service ${index} message limit is invalid`);
    }
    if (!Array.isArray(service.requiredCapabilities)
      || service.requiredCapabilities.some((capability) => typeof capability !== "string" || !configuredCapabilities.has(capability))) {
      throw new TypeError(`Realm service ${index} capabilities are invalid`);
    }
    if (services.some((candidate, candidateIndex) => candidateIndex < index
      && (candidate.path === service.path || candidate.path.startsWith(`${service.path}/`) || service.path.startsWith(`${candidate.path}/`)))) {
      throw new TypeError(`Realm service ${index} path overlaps another service`);
    }
  }
  let badgeCount = 0;
  let badgeRevision = 0;
  let server: Bun.Server<RealmSocketData>;
  const notificationTopic = `realm-notifications:${config.realmId}`;
  const notificationMessage = () => JSON.stringify({
    type: "badge.changed",
    realmId: config.realmId,
    revision: badgeRevision,
    count: badgeCount,
  });

  function requestBinding(request: Request): ReadonlySet<string> | undefined {
    const header = request.headers.get("authorization");
    return header?.startsWith("Bearer ") === true ? bindingForId(header.slice("Bearer ".length)) : undefined;
  }

  function bindingForId(bindingId: string): ReadonlySet<string> | undefined {
    const trusted = trustedBindings.get(bindingId);
    if (trusted) return trusted;
    const binding = publicBindings.get(bindingId);
    if (!binding) return undefined;
    if (binding.sessionId && (!config.auth?.sessionById(binding.sessionId) || (binding.expiresAt ?? 0) <= Date.now())) {
      revokeBinding(bindingId);
      return undefined;
    }
    return binding.capabilities;
  }

  function issueBinding(capabilities: readonly string[]) {
    if (capabilities.some((capability) => !configuredCapabilities.has(capability))) {
      throw new TypeError("binding capabilities must be published by the Realm");
    }
    if (trustedBindings.size >= maxTrustedBindings) throw new RangeError("trusted Realm binding limit reached");
    const bindingId = crypto.randomUUID();
    const granted = Object.freeze([...new Set(capabilities)]);
    trustedBindings.set(bindingId, new Set(granted));
    return Object.freeze({ bindingId, capabilities: granted });
  }

  function issuePublicBinding(session?: RealmSession) {
    if (config.auth && !session) throw new TypeError("authenticated Realm binding requires a session");
    if (publicBindings.size >= maxPublicBindings) revokeBinding(publicBindings.keys().next().value!);
    const bindingId = crypto.randomUUID();
    const requestedCapabilities = session?.principal === "agent" ? session.capabilities ?? [] : publicBindingCapabilities;
    const capabilities = Object.freeze([...new Set(requestedCapabilities.filter((capability) => publicBindingCapabilitySet.has(capability))) ]);
    publicBindings.set(bindingId, Object.freeze({
      capabilities: new Set(capabilities),
      sessionId: session?.id,
      expiresAt: session?.expiresAt,
    }));
    return Object.freeze({ bindingId, capabilities });
  }

  function revokeBinding(bindingId: string): boolean {
    const revoked = trustedBindings.delete(bindingId) || publicBindings.delete(bindingId);
    if (!revoked) return false;
    const sockets = activeBindingSockets.get(bindingId);
    activeBindingSockets.delete(bindingId);
    for (const socket of sockets ?? []) socket.close(1008, "Realm binding revoked");
    return true;
  }

  const unsubscribeSessionInvalidation = config.auth?.onSessionInvalidated((sessionId) => {
    for (const [bindingId, binding] of publicBindings) {
      if (binding.sessionId === sessionId) revokeBinding(bindingId);
    }
  });

  async function publication(origin: string) {
    const catalog = parseRealmCatalog({
      schemaVersion: SCHEMA_VERSION,
      realmId: config.realmId,
      generation: config.generation,
      defaultRouteId: config.defaultRoute.id,
      routes: await Promise.all(routeConfigs.map(async (route) => ({
        id: route.id,
        path: route.path,
        title: route.title,
        requiredCapabilities: [...route.requiredCapabilities],
        component: {
          id: route.componentId,
          hostApiRange: `^${HOST_API_VERSION}`,
          js: { url: `${origin}/artifacts/${route.id}.js`, sha256: await sha256Hex(route.js), mediaType: "text/javascript" },
          css: { url: `${origin}/artifacts/${route.id}.css`, sha256: await sha256Hex(route.css), mediaType: "text/css" },
        },
      }))),
    });
    const catalogText = JSON.stringify(catalog);
    return { catalog, catalogText };
  }

  server = Bun.serve<RealmSocketData>({
    hostname: config.hostname ?? "127.0.0.1",
    port: config.port,
    websocket: {
      maxPayloadLength: 512 * 1024,
      message(socket, message) {
        if (socket.data.authenticated && socket.data.bindingId && !bindingForId(socket.data.bindingId)) {
          socket.close(1008, "Realm session expired");
          return;
        }
        const maxLength = !socket.data.authenticated || socket.data.kind === "notifications" ? 1024 : socket.data.service.maxMessageBytes;
        const messageBytes = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
        if (messageBytes > maxLength || (socket.data.kind === "notifications" && typeof message !== "string")) {
          socket.close(1008, "invalid Realm channel message");
          return;
        }
        if (!socket.data.authenticated && typeof message !== "string") {
          socket.close(1008, "invalid Realm channel message");
          return;
        }
        if (!socket.data.authenticated) {
          let input: unknown;
          try { input = JSON.parse(message as string); } catch {
            socket.close(1008, "invalid Realm channel message");
            return;
          }
          if (!input || typeof input !== "object" || Array.isArray(input)) {
            socket.close(1008, "invalid Realm channel message");
            return;
          }
          const record = input as Record<string, unknown>;
          const binding = typeof record.bindingId === "string" ? bindingForId(record.bindingId) : undefined;
          if (Object.keys(record).sort().join(",") !== "bindingId,type"
            || record.type !== "authenticate"
            || !binding
            || (socket.data.kind === "service" && socket.data.service.requiredCapabilities.some((capability) => !binding.has(capability)))) {
            socket.close(1008, "invalid Realm channel authentication");
            return;
          }
          socket.data.authenticated = true;
          socket.data.bindingId = record.bindingId as string;
          const boundSockets = activeBindingSockets.get(socket.data.bindingId) ?? new Set<BoundSocket>();
          boundSockets.add(socket);
          activeBindingSockets.set(socket.data.bindingId, boundSockets);
          if (socket.data.kind === "notifications") {
            socket.subscribe(notificationTopic);
            socket.send(notificationMessage());
          } else {
            try {
              socket.data.session = socket.data.service.connect(Object.freeze({
                send(data) { socket.send(data); },
                close(code, reason) { socket.close(code, reason); },
              }));
            } catch {
              socket.close(1011, "Realm service unavailable");
            }
          }
          return;
        }
        if (socket.data.kind === "notifications" || !socket.data.session) {
          socket.close(1008, "invalid Realm channel message");
          return;
        }
        try {
          socket.data.session.message(typeof message === "string" ? message : new Uint8Array(message));
        } catch {
          socket.close(1008, "invalid Realm service message");
        }
      },
      close(socket) {
        if (socket.data.bindingId) {
          const boundSockets = activeBindingSockets.get(socket.data.bindingId);
          boundSockets?.delete(socket);
          if (boundSockets?.size === 0) activeBindingSockets.delete(socket.data.bindingId);
          socket.data.bindingId = undefined;
        }
        if (socket.data.kind !== "service") return;
        try { socket.data.session?.close?.(); } catch { /* service cleanup must not escape socket lifecycle */ }
        socket.data.session = undefined;
      },
    },
    async fetch(request, bunServer) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders });
      const url = new URL(request.url);
      const origin = config.auth?.publicOrigin ?? url.origin;
      if (request.method === "GET" && url.pathname === "/health") return json({ status: "ok", realmId: config.realmId });
      if (request.method === "GET" && url.pathname === "/.well-known/klivcore-realm") {
        return new Response(JSON.stringify({ schemaVersion: 1, realmId: config.realmId, name: config.name }), {
          headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" },
        });
      }
      const authResponse = await config.auth?.handle(request);
      if (authResponse) return authResponse;
      if (request.method === "GET" && url.pathname === "/v1/notifications") {
        if (config.auth && request.headers.get("origin") !== config.auth.publicOrigin) return json({ error: "forbidden" }, 403);
        if (bunServer.upgrade(request, { data: { authenticated: false, kind: "notifications" } })) return;
        return json({ error: "websocket upgrade required" }, 426);
      }
      const websocketService = request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket"
        ? services.find((service) => url.pathname === service.path)
        : undefined;
      if (websocketService) {
        if (config.auth && request.headers.get("origin") !== config.auth.publicOrigin) return json({ error: "forbidden" }, 403);
        if (bunServer.upgrade(request, { data: { authenticated: false, kind: "service", service: websocketService } })) return;
        return json({ error: "websocket upgrade required" }, 426);
      }
      if (request.method === "POST" && url.pathname === "/v1/bind") {
        let session: RealmSession | undefined;
        if (config.auth) {
          if (request.headers.get("origin") !== config.auth.publicOrigin) return json({ error: "forbidden" }, 403);
          session = config.auth.sessionFor(request);
          if (!session || session.realmId !== config.realmId) return json({ error: "unauthorized" }, 401);
        }
        const binding = issuePublicBinding(session);
        const { bindingId, capabilities } = binding;
        const { catalogText } = await publication(origin);
        const descriptor = parseRealmDescriptor({
          protocolVersion: PROTOCOL_VERSION,
          realmId: config.realmId,
          name: config.name,
          authority: { bindingId, epoch: config.authorityEpoch },
          publication: {
            catalogUrl: `${origin}/v1/catalog`,
            catalogSha256: await sha256Hex(catalogText),
            generation: config.generation,
            hostApiRange: `^${HOST_API_VERSION}`,
          },
          capabilities: [...capabilities],
        });
        return json(descriptor);
      }
      if (config.appV2
        && url.pathname !== "/health"
        && url.pathname !== "/v1" && !url.pathname.startsWith("/v1/")
        && url.pathname !== "/artifacts" && !url.pathname.startsWith("/artifacts/")
        && url.pathname !== "/.well-known" && !url.pathname.startsWith("/.well-known/")
        && url.pathname !== "/auth" && !url.pathname.startsWith("/auth/")) {
        const fallbackToIndex = url.pathname === "/" || routeConfigs.some((route) => route.path === url.pathname);
        const response = config.appV2.respond(request, fallbackToIndex, branding);
        if (response) {
          if (config.auth && !config.auth.sessionFor(request)) {
            return fallbackToIndex
              ? Response.redirect(`${config.auth.publicOrigin}/auth/login`, 302)
              : json({ error: "unauthorized" }, 401);
          }
          return response;
        }
      }
      const binding = requestBinding(request);
      if (!binding) return json({ error: "unauthorized" }, 401);
      const requestService = services.find((service) => url.pathname === service.path || url.pathname.startsWith(`${service.path}/`));
      if (requestService) {
        if (requestService.requiredCapabilities.some((capability) => !binding.has(capability))) return json({ error: "forbidden" }, 403);
        if (!requestService.handleRequest) return json({ error: "not found" }, 404);
        try {
          return withHeaders(await requestService.handleRequest(request, url), responseHeaders);
        } catch {
          return json({ error: "Realm service request failed" }, 500);
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/badge") {
        return json({ revision: badgeRevision, count: badgeCount });
      }
      if (request.method === "POST" && url.pathname.startsWith("/v1/badge/")) {
        if (config.auth && request.headers.get("origin") !== config.auth.publicOrigin) return json({ error: "forbidden" }, 403);
        const input = url.pathname.slice("/v1/badge/".length);
        if (!/^(0|[1-9]\d{0,2})$/.test(input)) return json({ error: "invalid badge count" }, 400);
        badgeCount = Number(input);
        badgeRevision = badgeRevision === Number.MAX_SAFE_INTEGER ? 0 : badgeRevision + 1;
        server.publish(notificationTopic, notificationMessage());
        return json({ revision: badgeRevision, count: badgeCount });
      }
      if (request.method === "GET" && url.pathname === "/v1/catalog") {
        const { catalogText } = await publication(origin);
        return new Response(catalogText, { headers: { ...responseHeaders, "content-type": "application/json; charset=utf-8" } });
      }
      const artifact = request.method === "GET"
        ? routeConfigs.find((route) => url.pathname === `/artifacts/${route.id}.js` || url.pathname === `/artifacts/${route.id}.css`)
        : undefined;
      if (artifact && url.pathname.endsWith(".js")) return new Response(artifact.js, { headers: { ...responseHeaders, "content-type": "text/javascript; charset=utf-8" } });
      if (artifact && url.pathname.endsWith(".css")) return new Response(artifact.css, { headers: { ...responseHeaders, "content-type": "text/css; charset=utf-8" } });
      return json({ error: "not found" }, 404);
    },
  });

  return Object.freeze({
    endpoint: `http://${server.hostname === "0.0.0.0" ? "127.0.0.1" : server.hostname}:${server.port}`,
    issueBinding,
    revokeBinding,
    issueRegistrationUrl(options) {
      if (!config.auth) throw new Error("Realm passkey authentication is not configured");
      return config.auth.issueRegistrationUrl(options);
    },
    stop() {
      unsubscribeSessionInvalidation?.();
      server.stop(true);
      config.auth?.close();
    },
  });
}
