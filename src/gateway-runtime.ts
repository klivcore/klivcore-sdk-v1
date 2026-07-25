import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseGatewayPackageLocator, type GatewayMountConfig } from "./start-realm-core";

export type GatewayProcess = Readonly<{ role: string; entrypoint: string }>;
export type GatewayManifest = Readonly<{
  schemaVersion: 1;
  contractVersion: 1;
  id: string;
  capabilities: readonly string[];
  routes: readonly Readonly<{
    id: string;
    path: string;
    title: string;
    requiredCapabilities: readonly string[];
    component: Readonly<{ id: string; js: string; css: string }>;
  }>[];
  httpRelay: Readonly<{
    requiredCapabilities: readonly string[];
    allowedRequests: readonly Readonly<{ method: "GET" | "HEAD" | "POST"; path?: string; pathPrefix?: string }>[];
    healthPath: string;
  }>;
  processes: readonly GatewayProcess[];
}>;

export type ActiveGatewayMount = Readonly<{
  schemaVersion: 1;
  key: string;
  source: string;
  revision: string;
  baseRoute: string;
  storageSubdir: string;
  packageRoot: string;
  home: string;
  configPath: string;
  port: number;
  sessions: Readonly<Record<string, string>>;
  manifest: GatewayManifest;
}>;

const idPattern = /^[a-z][a-z0-9]*(?:[-:][a-z0-9]+)*$/;
const capabilityPattern = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
const relativeRoutePattern = /^\/$|^\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;
const apiPathPattern = /^\/v1\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
const safePath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024
  && !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part && part !== "." && part !== ".." && /^[A-Za-z0-9._~-]+$/.test(part));
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Gateway package contract is invalid");
  return value as Record<string, unknown>;
};
const strings = (value: unknown, pattern: RegExp, maximum: number): readonly string[] => {
  if (!Array.isArray(value) || value.length > maximum || value.some((entry) => typeof entry !== "string" || !pattern.test(entry))) throw new TypeError("Gateway package contract is invalid");
  if (new Set(value).size !== value.length) throw new TypeError("Gateway package contract is invalid");
  return Object.freeze([...value]);
};

export function parseGatewayManifest(value: unknown): GatewayManifest {
  const root = record(value);
  if (!exact(root, ["schemaVersion", "contractVersion", "id", "capabilities", "routes", "httpRelay", "processes"])
    || root.schemaVersion !== 1 || root.contractVersion !== 1 || typeof root.id !== "string" || !idPattern.test(root.id)) throw new TypeError("Gateway package contract is invalid");
  const capabilities = strings(root.capabilities, capabilityPattern, 64);
  if (!Array.isArray(root.routes) || root.routes.length < 1 || root.routes.length > 32) throw new TypeError("Gateway package contract is invalid");
  const routes = root.routes.map((raw) => {
    const route = record(raw);
    const component = record(route.component);
    if (!exact(route, ["id", "path", "title", "requiredCapabilities", "component"])
      || typeof route.id !== "string" || !idPattern.test(route.id)
      || typeof route.path !== "string" || !relativeRoutePattern.test(route.path)
      || typeof route.title !== "string" || route.title.length < 1 || route.title.length > 100
      || !exact(component, ["id", "js", "css"]) || typeof component.id !== "string" || !idPattern.test(component.id)
      || !safePath(component.js) || !safePath(component.css)) throw new TypeError("Gateway package contract is invalid");
    const requiredCapabilities = strings(route.requiredCapabilities, capabilityPattern, 16);
    if (requiredCapabilities.some((capability) => !capabilities.includes(capability))) throw new TypeError("Gateway package contract is invalid");
    return Object.freeze({ id: route.id, path: route.path, title: route.title, requiredCapabilities, component: Object.freeze({ id: component.id, js: component.js, css: component.css }) });
  });
  if (new Set(routes.map((route) => route.id)).size !== routes.length || new Set(routes.map((route) => route.path)).size !== routes.length) throw new TypeError("Gateway package contract is invalid");
  const relay = record(root.httpRelay);
  if (!exact(relay, ["requiredCapabilities", "allowedRequests", "healthPath"]) || typeof relay.healthPath !== "string" || !apiPathPattern.test(relay.healthPath.replace(/^\/health$/u, "/v1/health"))) throw new TypeError("Gateway package contract is invalid");
  const relayCapabilities = strings(relay.requiredCapabilities, capabilityPattern, 16);
  if (relayCapabilities.some((capability) => !capabilities.includes(capability)) || !Array.isArray(relay.allowedRequests) || relay.allowedRequests.length < 1 || relay.allowedRequests.length > 32) throw new TypeError("Gateway package contract is invalid");
  const allowedRequests = relay.allowedRequests.map((raw) => {
    const rule = record(raw);
    const hasPath = rule.path !== undefined;
    if (!exact(rule, ["method", hasPath ? "path" : "pathPrefix"]) || !["GET", "HEAD", "POST"].includes(rule.method as string)
      || hasPath === (rule.pathPrefix !== undefined) || !apiPathPattern.test((rule.path ?? rule.pathPrefix) as string)) throw new TypeError("Gateway package contract is invalid");
    return Object.freeze({ method: rule.method as "GET" | "HEAD" | "POST", ...(hasPath ? { path: rule.path as string } : { pathPrefix: rule.pathPrefix as string }) });
  });
  if (!Array.isArray(root.processes) || root.processes.length < 1 || root.processes.length > 8) throw new TypeError("Gateway package contract is invalid");
  const processes = root.processes.map((raw) => {
    const process = record(raw);
    if (!exact(process, ["role", "entrypoint"]) || typeof process.role !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(process.role) || !safePath(process.entrypoint)) throw new TypeError("Gateway package contract is invalid");
    return Object.freeze({ role: process.role, entrypoint: process.entrypoint });
  });
  if (!processes.some((process) => process.role === "server") || new Set(processes.map((process) => process.role)).size !== processes.length) throw new TypeError("Gateway package contract is invalid");
  return Object.freeze({ schemaVersion: 1, contractVersion: 1, id: root.id, capabilities, routes: Object.freeze(routes), httpRelay: Object.freeze({ requiredCapabilities: relayCapabilities, allowedRequests: Object.freeze(allowedRequests), healthPath: relay.healthPath as string }), processes: Object.freeze(processes) });
}

export function gatewayMountRevision(key: string, mount: GatewayMountConfig): string {
  parseGatewayPackageLocator(mount.source);
  return createHash("sha256").update(JSON.stringify({ key, ...mount })).digest("hex");
}

export function gatewayProcessSessionName(realmId: string, stateDir: string, key: string, role: string): string {
  const digest = createHash("sha256").update(`${resolve(stateDir)}\0${key}\0${role}`).digest("hex").slice(0, 12);
  return `klivcore-${realmId}-${key}-${role}-${digest}`.slice(0, 96);
}

export async function readGatewayAsset(root: string, path: string, maximum = 1024 * 1024): Promise<string> {
  if (!safePath(path)) throw new Error("Gateway asset path is unsafe");
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, path);
  if (!absolute.startsWith(`${absoluteRoot}/`)) throw new Error("Gateway asset escaped package");
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error(`Gateway asset is invalid: ${basename(path)}`);
  return readFile(absolute, "utf8");
}

export async function loadGatewayManifest(packageRoot: string): Promise<GatewayManifest> {
  return parseGatewayManifest(JSON.parse(await readGatewayAsset(packageRoot, "klivcore.gateway.json", 128 * 1024)));
}

export function parseActiveGatewayMount(value: unknown): ActiveGatewayMount {
  const mount = record(value);
  if (!exact(mount, ["schemaVersion", "key", "source", "revision", "baseRoute", "storageSubdir", "packageRoot", "home", "configPath", "port", "sessions", "manifest"])
    || mount.schemaVersion !== 1 || typeof mount.key !== "string" || typeof mount.source !== "string" || typeof mount.revision !== "string" || !/^[a-f0-9]{64}$/.test(mount.revision)
    || typeof mount.baseRoute !== "string" || typeof mount.storageSubdir !== "string" || typeof mount.packageRoot !== "string" || !resolve(mount.packageRoot).startsWith("/")
    || typeof mount.home !== "string" || typeof mount.configPath !== "string" || !Number.isSafeInteger(mount.port) || (mount.port as number) < 1 || (mount.port as number) > 65535) throw new TypeError("active Gateway record is invalid");
  parseGatewayPackageLocator(mount.source);
  const sessions = record(mount.sessions);
  if (Object.values(sessions).some((session) => typeof session !== "string" || session.length < 1 || session.length > 100)) throw new TypeError("active Gateway record is invalid");
  return Object.freeze({ schemaVersion: 1, key: mount.key, source: mount.source, revision: mount.revision, baseRoute: mount.baseRoute, storageSubdir: mount.storageSubdir, packageRoot: mount.packageRoot, home: mount.home, configPath: mount.configPath, port: mount.port as number, sessions: Object.freeze({ ...sessions } as Record<string, string>), manifest: parseGatewayManifest(mount.manifest) });
}
