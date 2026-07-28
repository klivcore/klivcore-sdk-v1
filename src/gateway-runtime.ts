import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { parseGatewayPackageLocator, type GatewayMountConfig } from "./start-realm-core";

export type GatewayProcess = Readonly<{ role: string; entrypoint: string }>;
export type GatewayServer = Readonly<{
  id: string;
  process: string;
  requiredCapabilities: readonly string[];
  allowedRequests: readonly Readonly<{ method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE"; path?: string; pathPrefix?: string }>[];
  healthPath: string;
}>;
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
    services: readonly string[];
    component: Readonly<{ id: string; js: string; css: string }>;
  }>[];
  server: GatewayServer | null;
  processes: readonly GatewayProcess[];
}>;

export type ActiveGatewayMount = Readonly<{
  schemaVersion: 1;
  key: string;
  source: string;
  revision: string;
  packageDigest: string;
  serviceUser: string;
  serviceUid: number;
  serviceGid: number;
  baseRoute: string;
  storageSubdir: string;
  packageRoot: string;
  home: string;
  configPath: string;
  port: number | null;
  sessions: Readonly<Record<string, string>>;
  manifest: GatewayManifest;
}>;

export type ActiveGatewayMountAuthority = Readonly<{ realmId: string; stateDir: string }>;

export function replaceActiveGatewayMount(
  mounts: readonly ActiveGatewayMount[],
  replacement: ActiveGatewayMount,
): readonly ActiveGatewayMount[] {
  return Object.freeze([...mounts.filter((mount) => mount.key !== replacement.key), replacement]
    .sort((left, right) => left.key.localeCompare(right.key)));
}

export function recoverGatewayPortFromWorkerEnvironment(
  text: string,
  expected: Readonly<Record<string, string>>,
): number {
  if (!text.endsWith("\0")) throw new TypeError("Gateway worker environment is invalid");
  const entries = text.slice(0, -1).split("\0");
  const values = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1) throw new TypeError("Gateway worker environment is invalid");
    const key = entry.slice(0, separator);
    if (values.has(key)) throw new TypeError("Gateway worker environment is invalid");
    values.set(key, entry.slice(separator + 1));
  }
  const expectedKeys = [...Object.keys(expected), "KLIVCORE_GATEWAY_PORT"].sort();
  if ([...values.keys()].sort().join("\0") !== expectedKeys.join("\0")
    || Object.entries(expected).some(([key, value]) => values.get(key) !== value)) {
    throw new TypeError("Gateway worker environment is invalid");
  }
  const rawPort = values.get("KLIVCORE_GATEWAY_PORT");
  if (!rawPort || !/^[1-9][0-9]{0,4}$/u.test(rawPort)) throw new TypeError("Gateway worker port is invalid");
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port > 65_535) throw new TypeError("Gateway worker port is invalid");
  return port;
}

export function gatewaySandboxIdentity(realmId: string, stateDir: string, key: string): string {
  return createHash("sha256").update(`${realmId}\0${resolve(stateDir)}\0${key}`).digest("hex").slice(0, 20);
}

export function gatewayServiceUser(realmId: string, stateDir: string, key: string): string {
  return `klivgw-${gatewaySandboxIdentity(realmId, stateDir, key)}`;
}

export function gatewaySandboxRoot(realmId: string, stateDir: string, key: string): string {
  return `/var/lib/klivcore/gateways/${gatewaySandboxIdentity(realmId, stateDir, key)}`;
}

export function gatewayImmutablePackageRoot(realmId: string, stateDir: string, key: string, revision: string, packageDigest: string): string {
  return `${gatewaySandboxRoot(realmId, stateDir, key)}/runtime/${revision}-${packageDigest.slice(0, 16)}`;
}

export function gatewayDurableHome(realmId: string, stateDir: string, key: string, storageSubdir: string): string {
  return `${gatewaySandboxRoot(realmId, stateDir, key)}/state/${storageSubdir}`;
}

export async function gatewayPackageDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  let count = 0;
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Gateway package contains a symlink: ${relative(root, path)}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const info = await lstat(path);
        count += 1;
        bytes += info.size;
        if (count > 512 || bytes > 64 * 1024 * 1024) throw new Error("Gateway package exceeds safety limits");
        const name = relative(root, path).replaceAll("\\", "/");
        hash.update(name).update("\0").update(String(info.size)).update("\0").update(await readFile(path)).update("\0");
      } else throw new Error("Gateway package contains an unsupported filesystem entry");
    }
  };
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Gateway package root is invalid");
  await visit(root);
  return hash.digest("hex");
}

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
  if (!exact(root, ["schemaVersion", "contractVersion", "id", "capabilities", "routes", "server", "processes"])
    || root.schemaVersion !== 1 || root.contractVersion !== 1 || typeof root.id !== "string" || !idPattern.test(root.id)) throw new TypeError("Gateway package contract is invalid");
  const capabilities = strings(root.capabilities, capabilityPattern, 64);
  if (!Array.isArray(root.routes) || root.routes.length < 1 || root.routes.length > 32) throw new TypeError("Gateway package contract is invalid");
  const routes = root.routes.map((raw) => {
    const route = record(raw);
    const component = record(route.component);
    if (!exact(route, ["id", "path", "title", "requiredCapabilities", "services", "component"])
      || typeof route.id !== "string" || !idPattern.test(route.id)
      || typeof route.path !== "string" || !relativeRoutePattern.test(route.path)
      || typeof route.title !== "string" || route.title.length < 1 || route.title.length > 100
      || !exact(component, ["id", "js", "css"]) || typeof component.id !== "string" || !idPattern.test(component.id)
      || !safePath(component.js) || !safePath(component.css)) throw new TypeError("Gateway package contract is invalid");
    const requiredCapabilities = strings(route.requiredCapabilities, capabilityPattern, 16);
    if (requiredCapabilities.some((capability) => !capabilities.includes(capability))) throw new TypeError("Gateway package contract is invalid");
    const services = strings(route.services, idPattern, 8);
    return Object.freeze({ id: route.id, path: route.path, title: route.title, requiredCapabilities, services, component: Object.freeze({ id: component.id, js: component.js, css: component.css }) });
  });
  if (new Set(routes.map((route) => route.id)).size !== routes.length || new Set(routes.map((route) => route.path)).size !== routes.length) throw new TypeError("Gateway package contract is invalid");
  if (!Array.isArray(root.processes) || root.processes.length > 8) throw new TypeError("Gateway package contract is invalid");
  const processes = root.processes.map((raw) => {
    const process = record(raw);
    if (!exact(process, ["role", "entrypoint"]) || typeof process.role !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(process.role) || !safePath(process.entrypoint)) throw new TypeError("Gateway package contract is invalid");
    return Object.freeze({ role: process.role, entrypoint: process.entrypoint });
  });
  if (new Set(processes.map((process) => process.role)).size !== processes.length) throw new TypeError("Gateway package contract is invalid");
  let server: GatewayServer | null = null;
  if (root.server !== null) {
    const rawServer = record(root.server);
    if (!exact(rawServer, ["id", "process", "requiredCapabilities", "allowedRequests", "healthPath"])
      || typeof rawServer.id !== "string" || !idPattern.test(rawServer.id)
      || typeof rawServer.process !== "string" || !processes.some((process) => process.role === rawServer.process)
      || typeof rawServer.healthPath !== "string" || !apiPathPattern.test(rawServer.healthPath.replace(/^\/health$/u, "/v1/health"))) throw new TypeError("Gateway package contract is invalid");
    const serverCapabilities = strings(rawServer.requiredCapabilities, capabilityPattern, 16);
    if (serverCapabilities.some((capability) => !capabilities.includes(capability)) || !Array.isArray(rawServer.allowedRequests) || rawServer.allowedRequests.length < 1 || rawServer.allowedRequests.length > 32) throw new TypeError("Gateway package contract is invalid");
    const allowedRequests = rawServer.allowedRequests.map((raw) => {
      const rule = record(raw);
      const hasPath = rule.path !== undefined;
      if (!exact(rule, ["method", hasPath ? "path" : "pathPrefix"]) || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(rule.method as string)
        || hasPath === (rule.pathPrefix !== undefined) || !apiPathPattern.test((rule.path ?? rule.pathPrefix) as string)) throw new TypeError("Gateway package contract is invalid");
      return Object.freeze({ method: rule.method as "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE", ...(hasPath ? { path: rule.path as string } : { pathPrefix: rule.pathPrefix as string }) });
    });
    server = Object.freeze({ id: rawServer.id, process: rawServer.process, requiredCapabilities: serverCapabilities, allowedRequests: Object.freeze(allowedRequests), healthPath: rawServer.healthPath as string });
  }
  if (routes.some((route) => route.services.some((service) => service !== server?.id))) throw new TypeError("Gateway package contract is invalid");
  return Object.freeze({ schemaVersion: 1, contractVersion: 1, id: root.id, capabilities, routes: Object.freeze(routes), server, processes: Object.freeze(processes) });
}

export function gatewayMountRevision(key: string, mount: GatewayMountConfig): string {
  parseGatewayPackageLocator(mount.source);
  return createHash("sha256").update(JSON.stringify({ key, ...mount })).digest("hex");
}

export function gatewayProcessSessionName(realmId: string, stateDir: string, key: string, role: string): string {
  const digest = createHash("sha256").update(`${resolve(stateDir)}\0${key}\0${role}`).digest("hex").slice(0, 12);
  return `klivcore-${realmId}-${key}-${role}-${digest}`.slice(0, 96);
}

export function gatewayProcessSupervisorArgv(
  uid: number,
  gid: number,
  environment: Readonly<Record<string, string>>,
  workerArgv: readonly string[],
): readonly string[] {
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) throw new TypeError("Gateway service identity is invalid");
  const assignments = Object.entries(environment).map(([name, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || value.includes("\0")) throw new TypeError("Gateway process environment is invalid");
    return `${name}=${value}`;
  });
  if (workerArgv.length < 1 || workerArgv.some((value) => !value || value.includes("\0"))) throw new TypeError("Gateway worker argv is invalid");
  return Object.freeze([
    "sudo", "-n", `--user=#${uid}`, `--group=#${gid}`, "--", "/usr/bin/env", "-i",
    ...assignments,
    ...workerArgv,
  ]);
}

export function gatewayLegacyProcessSupervisorArgv(
  uid: number,
  gid: number,
  environment: Readonly<Record<string, string>>,
  workerArgv: readonly string[],
): readonly string[] {
  const portable = gatewayProcessSupervisorArgv(uid, gid, environment, workerArgv);
  return Object.freeze([
    "sudo", "-n", "--", "/usr/bin/setpriv", `--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", "env", "-i",
    ...portable.slice(7),
  ]);
}

export function gatewayProcessSupervisorArgvCompatible(
  actual: readonly string[],
  expected: readonly string[],
  uid: number,
  gid: number,
): boolean {
  if (actual.length === expected.length && actual.every((value, index) => value === expected[index])) return true;
  const expectedPrefix = ["sudo", "-n", `--user=#${uid}`, `--group=#${gid}`, "--", "/usr/bin/env", "-i"];
  const legacyPrefix = ["sudo", "-n", "--", "/usr/bin/setpriv", `--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", "env", "-i"];
  if (expected.length <= expectedPrefix.length || actual.length <= legacyPrefix.length) return false;
  if (!expectedPrefix.every((value, index) => expected[index] === value)) return false;
  if (!legacyPrefix.every((value, index) => actual[index] === value)) return false;
  const expectedTail = expected.slice(expectedPrefix.length);
  const actualTail = actual.slice(legacyPrefix.length);
  return actualTail.length === expectedTail.length && actualTail.every((value, index) => value === expectedTail[index]);
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

function parsePersistedGatewayManifest(value: unknown): GatewayManifest {
  try { return parseGatewayManifest(value); } catch (currentError) {
    try {
      const root = record(value);
      if (!exact(root, ["schemaVersion", "contractVersion", "id", "capabilities", "routes", "httpRelay", "processes"])
        || !Array.isArray(root.routes)) throw currentError;
      const relay = record(root.httpRelay);
      if (!exact(relay, ["requiredCapabilities", "allowedRequests", "healthPath"])) throw currentError;
      if (!Array.isArray(relay.allowedRequests) || relay.allowedRequests.some((raw) => {
        const rule = record(raw);
        return !["GET", "HEAD", "POST"].includes(rule.method as string);
      })) throw currentError;
      const routes = root.routes.map((raw) => {
        const route = record(raw);
        if (!exact(route, ["id", "path", "title", "requiredCapabilities", "component"])) throw currentError;
        return { ...route, services: ["legacy-http-relay"] };
      });
      return parseGatewayManifest({
        schemaVersion: root.schemaVersion,
        contractVersion: root.contractVersion,
        id: root.id,
        capabilities: root.capabilities,
        routes,
        server: {
          id: "legacy-http-relay",
          process: "server",
          requiredCapabilities: relay.requiredCapabilities,
          allowedRequests: relay.allowedRequests,
          healthPath: relay.healthPath,
        },
        processes: root.processes,
      });
    } catch { throw currentError; }
  }
}

export function parseActiveGatewayMount(value: unknown, authority: ActiveGatewayMountAuthority): ActiveGatewayMount {
  const mount = record(value);
  if (!exact(mount, ["schemaVersion", "key", "source", "revision", "packageDigest", "serviceUser", "serviceUid", "serviceGid", "baseRoute", "storageSubdir", "packageRoot", "home", "configPath", "port", "sessions", "manifest"])
    || mount.schemaVersion !== 1 || typeof mount.key !== "string" || typeof mount.source !== "string" || typeof mount.revision !== "string" || !/^[a-f0-9]{64}$/.test(mount.revision)
    || typeof mount.packageDigest !== "string" || !/^[a-f0-9]{64}$/.test(mount.packageDigest)
    || typeof mount.serviceUser !== "string" || !/^klivgw-[a-f0-9]{20}$/.test(mount.serviceUser)
    || !Number.isSafeInteger(mount.serviceUid) || (mount.serviceUid as number) < 1
    || !Number.isSafeInteger(mount.serviceGid) || (mount.serviceGid as number) < 1
    || typeof mount.baseRoute !== "string" || typeof mount.storageSubdir !== "string" || typeof mount.packageRoot !== "string" || !resolve(mount.packageRoot).startsWith("/")
    || typeof mount.home !== "string" || typeof mount.configPath !== "string"
    || (mount.port !== null && (!Number.isSafeInteger(mount.port) || (mount.port as number) < 1 || (mount.port as number) > 65535))) throw new TypeError("active Gateway record is invalid");
  parseGatewayPackageLocator(mount.source);
  const sessions = record(mount.sessions);
  if (Object.values(sessions).some((session) => typeof session !== "string" || session.length < 1 || session.length > 100)) throw new TypeError("active Gateway record is invalid");
  const manifest = parsePersistedGatewayManifest(mount.manifest);
  const roles = manifest.processes.map((process) => process.role).sort();
  const sessionRoles = Object.keys(sessions).sort();
  if (sessionRoles.length !== roles.length || sessionRoles.some((role, index) => role !== roles[index])) throw new TypeError("active Gateway record is invalid");
  if (roles.some((role) => sessions[role] !== gatewayProcessSessionName(authority.realmId, authority.stateDir, mount.key as string, role))) throw new TypeError("active Gateway record is invalid");
  if ((manifest.server === null) !== (mount.port === null)) throw new TypeError("active Gateway record is invalid");
  return Object.freeze({ schemaVersion: 1, key: mount.key, source: mount.source, revision: mount.revision, packageDigest: mount.packageDigest, serviceUser: mount.serviceUser, serviceUid: mount.serviceUid as number, serviceGid: mount.serviceGid as number, baseRoute: mount.baseRoute, storageSubdir: mount.storageSubdir, packageRoot: mount.packageRoot, home: mount.home, configPath: mount.configPath, port: mount.port as number | null, sessions: Object.freeze({ ...sessions } as Record<string, string>), manifest });
}
