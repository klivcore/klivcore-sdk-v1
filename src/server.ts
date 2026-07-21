import { HOST_API_VERSION, PROTOCOL_VERSION, SCHEMA_VERSION, parseRealmCatalog, parseRealmDescriptor } from "./contracts";
import { sha256Hex } from "./client";

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
  hostname?: string;
  port: number;
  realmId: string;
  name: string;
  authorityEpoch: string;
  generation: string;
  capabilities: readonly string[];
  defaultRoute: RealmGatewayRouteConfig;
  routes?: readonly RealmGatewayRouteConfig[];
}>;

export type RunningRealmGateway = Readonly<{
  endpoint: string;
  stop(): void;
}>;

const corsHeaders = {
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-origin": "*",
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

export function createRealmGateway(config: RealmGatewayConfig): RunningRealmGateway {
  const bindings = new Set<string>();
  const routeConfigs = [config.defaultRoute, ...(config.routes ?? [])];
  let server: Bun.Server<undefined>;

  function authorized(request: Request) {
    const header = request.headers.get("authorization");
    return header?.startsWith("Bearer ") === true && bindings.has(header.slice("Bearer ".length));
  }

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

  server = Bun.serve({
    hostname: config.hostname ?? "127.0.0.1",
    port: config.port,
    async fetch(request) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
      const url = new URL(request.url);
      const origin = url.origin;
      if (request.method === "GET" && url.pathname === "/health") return json({ status: "ok", realmId: config.realmId });
      if (request.method === "POST" && url.pathname === "/v1/bind") {
        const bindingId = crypto.randomUUID();
        if (bindings.size >= 256) bindings.delete(bindings.values().next().value!);
        bindings.add(bindingId);
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
          capabilities: [...config.capabilities],
        });
        return json(descriptor);
      }
      if (!authorized(request)) return json({ error: "unauthorized" }, 401);
      const { catalogText } = await publication(origin);
      if (request.method === "GET" && url.pathname === "/v1/catalog") {
        return new Response(catalogText, { headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" } });
      }
      const artifact = request.method === "GET"
        ? routeConfigs.find((route) => url.pathname === `/artifacts/${route.id}.js` || url.pathname === `/artifacts/${route.id}.css`)
        : undefined;
      if (artifact && url.pathname.endsWith(".js")) return new Response(artifact.js, { headers: { ...corsHeaders, "content-type": "text/javascript; charset=utf-8" } });
      if (artifact && url.pathname.endsWith(".css")) return new Response(artifact.css, { headers: { ...corsHeaders, "content-type": "text/css; charset=utf-8" } });
      return json({ error: "not found" }, 404);
    },
  });

  return Object.freeze({
    endpoint: `http://${server.hostname === "0.0.0.0" ? "127.0.0.1" : server.hostname}:${server.port}`,
    stop() { server.stop(true); },
  });
}
