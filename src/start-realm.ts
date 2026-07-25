import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadPublishedAppV2, resolvePublishedAppV2Root } from "./app-launcher";
import { gatewayDurableHome, gatewayImmutablePackageRoot, gatewayMountRevision, gatewayPackageDigest, gatewayServiceUser, parseActiveGatewayMount, readGatewayAsset } from "./gateway-runtime";
import { createPasskeyAuth, createRealmGateway, type RealmGatewayHttpRelay, type RealmGatewayRouteConfig } from "./server";
import { desktopSshRelayPort, parseActiveRealmRecord, parseActiveSshRelayRecord, parseQuickTunnelUrl, parseStartRealmArgs, parseStartRealmConfig, planStartRealmTunnel, probePublicHealth, resolveCloudflaredAsset, waitForManagedPublicHealth } from "./start-realm-core";

let invocation: ReturnType<typeof parseStartRealmArgs>;
try {
  invocation = parseStartRealmArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const configPath = resolve(invocation.configPath);
const config = parseStartRealmConfig(JSON.parse(await readFile(configPath, "utf8")));
const stateDir = resolve(dirname(configPath), config.stateDir);
await mkdir(stateDir, { recursive: true, mode: 0o700 });
await chmod(stateDir, 0o700);
const activeRealmPath = resolve(stateDir, "active-realm.json");
const activeSshRelayPath = resolve(stateDir, "active-ssh-relay.json");
const activeGatewaysPath = resolve(stateDir, "active-gateways.json");
const workerMode = process.env.KLIVCORE_START_REALM_MODE;
if (workerMode !== undefined && !["tunnel", "realm", "ssh-relay", "ssh-tunnel"].includes(workerMode)) {
  throw new Error("invalid internal start-realm worker mode");
}
const managedTunnelPath = resolve(stateDir, workerMode === "ssh-tunnel" ? "managed-ssh-tunnel.json" : "managed-tunnel.json");
const sshRelayPort = desktopSshRelayPort(config.port);
const runtimeRevision = process.env.KLIVCORE_START_REALM_RUNTIME_REVISION;
if (workerMode === "realm" && (!runtimeRevision || !/^[a-f0-9]{64}$/.test(runtimeRevision))) {
  throw new Error("managed Realm worker runtime revision is missing or invalid");
}
const forcedPublicOrigin = process.env.KLIVCORE_START_REALM_PUBLIC_ORIGIN;
const forcedSshPublicOrigin = process.env.KLIVCORE_START_REALM_SSH_PUBLIC_ORIGIN;
const managedTunnelPid = (() => {
  const value = process.env.KLIVCORE_START_REALM_TUNNEL_PID;
  if (value === undefined) return undefined;
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("invalid managed tunnel worker pid");
  return pid;
})();

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function loadMountedGateways(): Promise<Readonly<{
  capabilities: readonly string[];
  routes: readonly RealmGatewayRouteConfig[];
  httpRelays: readonly RealmGatewayHttpRelay[];
}>> {
  const configured = config.gateways ?? {};
  if (Object.keys(configured).length === 0) return Object.freeze({ capabilities: Object.freeze([]), routes: Object.freeze([]), httpRelays: Object.freeze([]) });
  const info = await lstat(activeGatewaysPath);
  const uid = process.getuid?.();
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 1024 * 1024
    || (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) || (uid !== undefined && info.uid !== uid)) throw new Error("active Gateway registry is unsafe");
  const value = JSON.parse(await readFile(activeGatewaysPath, "utf8"));
  if (!Array.isArray(value) || value.length !== Object.keys(configured).length) throw new Error("active Gateway registry does not match Realm configuration");
  const mounts = value.map(parseActiveGatewayMount);
  const routes: RealmGatewayRouteConfig[] = [];
  const httpRelays: RealmGatewayHttpRelay[] = [];
  const capabilities = new Set<string>();
  for (const mount of mounts) {
    const expected = configured[mount.key];
    if (!expected || mount.source !== expected.source || mount.revision !== gatewayMountRevision(mount.key, expected)
      || mount.baseRoute !== expected.baseRoute || mount.storageSubdir !== expected.storageSubdir
      || mount.serviceUser !== gatewayServiceUser(config.realm.id, stateDir, mount.key)
      || resolve(mount.home) !== gatewayDurableHome(config.realm.id, stateDir, mount.key, expected.storageSubdir)
      || resolve(mount.configPath) !== resolve(mount.home, "config.json")
      || resolve(mount.packageRoot) !== gatewayImmutablePackageRoot(config.realm.id, stateDir, mount.key, mount.revision, mount.packageDigest)
      || await gatewayPackageDigest(mount.packageRoot) !== mount.packageDigest) {
      throw new Error(`active Gateway mount does not match configuration: ${mount.key}`);
    }
    for (const capability of mount.manifest.capabilities) capabilities.add(capability);
    for (const route of mount.manifest.routes) {
      routes.push(Object.freeze({
        id: `${mount.key}:${route.id}`,
        path: route.path === "/" ? mount.baseRoute : `${mount.baseRoute}${route.path}`,
        title: route.title,
        requiredCapabilities: route.requiredCapabilities,
        services: route.services.map((id) => {
          if (mount.port === null || mount.manifest.server?.id !== id) throw new Error(`Gateway route service is unavailable: ${mount.key}/${id}`);
          return Object.freeze({ id, endpoint: `/:${mount.port}` });
        }),
        componentId: `${mount.key}:${route.component.id}`,
        js: await readGatewayAsset(mount.packageRoot, route.component.js),
        css: await readGatewayAsset(mount.packageRoot, route.component.css),
      }));
    }
    if (mount.manifest.server !== null) {
      if (mount.port === null) throw new Error(`Gateway server port is unavailable: ${mount.key}`);
      httpRelays.push(Object.freeze({
        port: mount.port,
        requiredCapabilities: mount.manifest.server.requiredCapabilities,
        allowedRequests: mount.manifest.server.allowedRequests,
      }));
    }
  }
  if (new Set(routes.map((route) => route.path)).size !== routes.length) throw new Error("mounted Gateway route conflict");
  return Object.freeze({ capabilities: Object.freeze([...capabilities]), routes: Object.freeze(routes), httpRelays: Object.freeze(httpRelays) });
}

async function cloudflaredPath(): Promise<string> {
  const asset = resolveCloudflaredAsset(process.platform, process.arch);
  const binDir = resolve(stateDir, "bin");
  const path = resolve(binDir, `cloudflared-${asset.version}`);
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  const existing = await lstat(path).catch(() => undefined);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || await digest(path) !== asset.sha256) {
      throw new Error(`cached cloudflared is invalid: ${path}`);
    }
    await chmod(path, 0o700);
    return path;
  }
  console.log(`Installing pinned cloudflared ${asset.version}...`);
  const response = await fetch(asset.url, { redirect: "follow" });
  const downloadHost = new URL(response.url).hostname;
  if (!response.ok || (downloadHost !== "github.com" && downloadHost !== "release-assets.githubusercontent.com")) {
    throw new Error(`cloudflared download failed (${response.status})`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > 64 * 1024 * 1024) throw new Error("cloudflared download size is invalid");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== declared || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    throw new Error("cloudflared download integrity check failed");
  }
  const stage = `${path}.stage-${crypto.randomUUID()}`;
  try {
    await writeFile(stage, bytes, { flag: "wx", mode: 0o700 });
    await rename(stage, path);
  } finally {
    await rm(stage, { force: true });
  }
  return path;
}

async function captureTunnelOrigin(child: Bun.Subprocess<"ignore", "ignore", "pipe">): Promise<string> {
  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(remaining).then(() => ({ done: true as const, value: undefined })),
    ]);
    if (next.done) break;
    text = `${text}${decoder.decode(next.value, { stream: true })}`.slice(-64 * 1024);
    const origin = parseQuickTunnelUrl(text);
    if (origin) {
      void (async () => {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            process.stderr.write(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
      })();
      return origin;
    }
  }
  reader.releaseLock();
  throw new Error("cloudflared did not provide a Quick Tunnel URL within 30 seconds");
}

async function waitForHealth(origin: string, realmId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "unreachable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`, { redirect: "error", signal: AbortSignal.timeout(5_000) });
      const value = response.headers.get("content-type")?.includes("application/json") ? await response.json() as Record<string, unknown> : undefined;
      if (response.ok && value?.status === "ok" && value.realmId === realmId) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(500);
  }
  throw new Error(`Realm health check failed for ${origin}: ${last}`);
}

async function issueRegistrationUrl(): Promise<string> {
  const info = await lstat(activeRealmPath).catch(() => undefined);
  const getuid = process.getuid?.();
  if (!info || !info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600
    || info.size < 2 || info.size > 4_096 || (getuid !== undefined && info.uid !== getuid)) {
    throw new Error("active Realm record is unavailable or unsafe; start the Realm first");
  }
  const record = parseActiveRealmRecord(
    JSON.parse(await readFile(activeRealmPath, "utf8")),
    config.realm.id,
    config.port,
    config.publicOrigin,
  );
  try { process.kill(record.pid, 0); } catch { throw new Error("active Realm process is not running"); }
  await waitForHealth(record.localOrigin, config.realm.id, 5_000);
  await probePublicHealth(record.publicOrigin, config.realm.id);
  const response = await fetch(`${record.localOrigin}/v1/auth/runtime/registration-url`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${record.registrationControlToken}`,
      "content-type": "application/json",
      origin: record.publicOrigin,
    },
    body: "{}",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 201 || !response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("live Realm refused registration URL issuance");
  }
  const value = await response.json() as Record<string, unknown>;
  if (Object.keys(value).join(",") !== "registrationUrl" || typeof value.registrationUrl !== "string") {
    throw new Error("live Realm returned an invalid registration URL");
  }
  const registrationUrl = new URL(value.registrationUrl);
  if (registrationUrl.origin !== record.publicOrigin || registrationUrl.pathname !== "/auth/register"
    || registrationUrl.search || registrationUrl.username || registrationUrl.password
    || !/^#token=[A-Za-z0-9_-]{32,128}$/.test(registrationUrl.hash)) {
    throw new Error("live Realm returned an invalid registration URL");
  }
  return registrationUrl.href;
}

if (invocation.command === "registration-url") {
  console.log(await issueRegistrationUrl());
  process.exit(0);
}

async function removeOwnedActiveRecord(): Promise<void> {
  try {
    const record = parseActiveRealmRecord(JSON.parse(await readFile(activeRealmPath, "utf8")), config.realm.id, config.port);
    if (record.pid === process.pid) await rm(activeRealmPath, { force: true });
  } catch { /* absent, stale, or foreign runtime records are not ours to remove */ }
}

async function removeOwnedSshRelayRecord(): Promise<void> {
  try {
    const sessionName = process.env.KLIVCORE_START_REALM_SSH_RELAY_SESSION;
    if (!sessionName) return;
    const record = parseActiveSshRelayRecord(
      JSON.parse(await readFile(activeSshRelayPath, "utf8")),
      config.realm.id,
      sshRelayPort,
      sessionName,
    );
    if (record.pid === process.pid) await rm(activeSshRelayPath, { force: true });
  } catch { /* absent, stale, or foreign runtime records are not ours to remove */ }
}

async function removeOwnedTunnelRecord(): Promise<void> {
  try {
    const value = JSON.parse(await readFile(managedTunnelPath, "utf8")) as Record<string, unknown>;
    if (value.pid === process.pid) await rm(managedTunnelPath, { force: true });
  } catch { /* absent or foreign tunnel records are not ours to remove */ }
}

let tunnel: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
let gateway: ReturnType<typeof createRealmGateway> | undefined;
let auth: ReturnType<typeof createPasskeyAuth> | undefined;
let stopping: Promise<void> | undefined;
async function stop(): Promise<void> {
  if (stopping) return stopping;
  stopping = (async () => {
    gateway?.stop();
    await removeOwnedActiveRecord();
    await removeOwnedSshRelayRecord();
    await removeOwnedTunnelRecord();
    auth?.close();
    if (tunnel && tunnel.exitCode === null) {
      tunnel.kill("SIGTERM");
      await Promise.race([tunnel.exited.then(() => undefined), Bun.sleep(5_000)]);
      if (tunnel.exitCode === null) {
        tunnel.kill("SIGKILL");
        await tunnel.exited;
      }
    }
  })();
  return stopping;
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => { void stop().finally(() => process.exit(0)); });
}

async function runSshRelay(): Promise<never> {
  if (!config.desktop) throw new Error("managed SSH relay requires desktop.ssh configuration");
  const publicOrigin = forcedPublicOrigin;
  const sessionName = process.env.KLIVCORE_START_REALM_SSH_RELAY_SESSION;
  const configRevision = process.env.KLIVCORE_START_REALM_SSH_CONFIG_REVISION;
  if (!publicOrigin || !sessionName || !configRevision || !/^[a-f0-9]{64}$/.test(configRevision)) {
    throw new Error("managed SSH relay identity is missing");
  }
  const branding = Object.freeze({ canvasColor: config.realm.canvasColor });
  const registrationControlToken = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  auth = createPasskeyAuth({
    branding,
    databasePath: resolve(stateDir, "auth.sqlite"),
    realmId: config.realm.id,
    realmName: config.realm.name,
    publicOrigin,
    rpId: new URL(publicOrigin).hostname,
    registrationControlToken,
  });
  gateway = createRealmGateway({
    mode: "desktop-ssh",
    branding,
    hostname: "127.0.0.1",
    port: sshRelayPort,
    realmId: config.realm.id,
    name: config.realm.name,
    authorityEpoch: `${config.realm.id}-ssh-1`,
    generation: `${config.realm.id}-ssh-1`,
    capabilities: [],
    auth,
    desktop: Object.freeze({
      ssh: Object.freeze({
        ...config.desktop.ssh,
        authorizedKeysFile: resolve(stateDir, "desktop-authorized-keys"),
      }),
    }),
    defaultRoute: {
      id: "ssh-core",
      path: "/",
      title: "SSH Core",
      requiredCapabilities: [],
      componentId: "ssh-core",
      js: "",
      css: "",
    },
  });
  await waitForHealth(gateway.endpoint, config.realm.id, 10_000);
  const stage = `${activeSshRelayPath}.stage-${crypto.randomUUID()}`;
  try {
    await writeFile(stage, `${JSON.stringify({
      schemaVersion: 2,
      pid: process.pid,
      realmId: config.realm.id,
      localOrigin: gateway.endpoint,
      sessionName,
      configRevision,
      realmPublicOrigin: publicOrigin,
    })}\n`, { flag: "wx", mode: 0o600 });
    await rename(stage, activeSshRelayPath);
    await chmod(activeSshRelayPath, 0o600);
  } finally {
    await rm(stage, { force: true });
  }
  console.log(`SSH Core relay ready: ${gateway.endpoint}`);
  return await new Promise<never>(() => {});
}

if (workerMode === "ssh-relay") await runSshRelay();

try {
  let publicOrigin: string;
  const tunnelPort = workerMode === "ssh-tunnel" ? sshRelayPort : config.port;
  const tunnelPlan = workerMode === "ssh-tunnel"
    ? ({ mode: "managed" } as const)
    : forcedPublicOrigin
      ? planStartRealmTunnel(parseStartRealmConfig({ ...config, publicOrigin: forcedPublicOrigin }))
      : planStartRealmTunnel(config);
  if (tunnelPlan.mode === "external") {
    publicOrigin = tunnelPlan.publicOrigin;
    console.log(`Using externally managed tunnel: ${publicOrigin}`);
  } else {
    const executable = await cloudflaredPath();
    console.log("Starting managed Quick Tunnel...");
    tunnel = Bun.spawn([
      executable,
      "tunnel",
      "--config", "/dev/null",
      "--no-autoupdate",
      "--url", `http://127.0.0.1:${tunnelPort}`,
    ], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    publicOrigin = await captureTunnelOrigin(tunnel);
    console.log(`Quick Tunnel allocated: ${publicOrigin}`);
  }
  if (workerMode === "tunnel" || workerMode === "ssh-tunnel") {
    if (!tunnel) throw new Error("managed tunnel worker requires a managed Quick Tunnel");
    const sessionName = process.env.KLIVCORE_START_REALM_TUNNEL_SESSION;
    if (!sessionName) throw new Error("managed tunnel worker session identity is missing");
    const stage = `${managedTunnelPath}.stage-${crypto.randomUUID()}`;
    try {
      await writeFile(stage, `${JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        realmId: config.realm.id,
        localOrigin: `http://127.0.0.1:${tunnelPort}`,
        publicOrigin,
        sessionName,
      })}\n`, { flag: "wx", mode: 0o600 });
      await rename(stage, managedTunnelPath);
      await chmod(managedTunnelPath, 0o600);
    } finally {
      await rm(stage, { force: true });
    }
    console.log(`Managed Quick Tunnel ready: ${publicOrigin}`);
    const code = await tunnel.exited;
    await removeOwnedTunnelRecord();
    process.exit(code);
  }
  const branding = Object.freeze({ canvasColor: config.realm.canvasColor });
  const registrationControlToken = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const appRoot = await resolvePublishedAppV2Root(resolve(import.meta.dir, "../app-v2"));
  const appV2 = await loadPublishedAppV2(appRoot);
  const mountedGateways = await loadMountedGateways();
  const publishedCapabilities = Object.freeze(["realm:view", ...mountedGateways.capabilities]);
  console.log(`Starting Realm on http://127.0.0.1:${config.port}...`);
  auth = createPasskeyAuth({
    branding,
    databasePath: resolve(stateDir, "auth.sqlite"),
    realmId: config.realm.id,
    realmName: config.realm.name,
    publicOrigin,
    rpId: new URL(publicOrigin).hostname,
    registrationControlToken,
  });
  gateway = createRealmGateway({
    branding,
    hostname: "127.0.0.1",
    port: config.port,
    realmId: config.realm.id,
    name: config.realm.name,
    authorityEpoch: `${config.realm.id}-1`,
    generation: `${config.realm.id}-1`,
    runtimeVersion: runtimeRevision?.slice(0, 12),
    capabilities: publishedCapabilities,
    publicBindingCapabilities: publishedCapabilities,
    appV2,
    auth,
    httpRelays: mountedGateways.httpRelays,
    routes: mountedGateways.routes,
    desktop: config.desktop ? Object.freeze({
      ...(forcedSshPublicOrigin ? { relayUrl: `${forcedSshPublicOrigin.replace(/^https:/u, "wss:")}/v1/desktop/ssh` } : {}),
      ssh: Object.freeze({
        ...config.desktop.ssh,
        authorizedKeysFile: resolve(stateDir, "desktop-authorized-keys"),
      }),
    }) : undefined,
    defaultRoute: {
      id: "home",
      path: "/",
      title: `${config.realm.name} Home`,
      requiredCapabilities: ["realm:view"],
      componentId: "realm-home",
      js: `export function mount(host){const main=document.createElement("main");const label=document.createElement("p");label.textContent="Realm";const title=document.createElement("h1");title.textContent=${JSON.stringify(config.realm.name)};const ready=document.createElement("p");ready.textContent="Ready.";main.append(label,title,ready);host.root.replaceChildren(main);return ()=>host.root.replaceChildren()}`,
      css: `:host{display:block;min-height:100%;background:${config.realm.canvasColor};color:#f7f3e8;font-family:ui-sans-serif,system-ui,sans-serif}main{box-sizing:border-box;min-height:100%;padding:clamp(3rem,9vw,7rem);display:grid;align-content:center}h1{font-size:clamp(3rem,8vw,7rem);margin:0}`,
    },
  });
  await waitForHealth(gateway.endpoint, config.realm.id, 10_000);
  console.log(`Local Realm health: ok (${gateway.endpoint})`);
  if (tunnel || managedTunnelPid) {
    const tunnelExitCode = (): number | null => {
      if (tunnel) return tunnel.exitCode;
      try { process.kill(managedTunnelPid!, 0); return null; } catch { return 1; }
    };
    await waitForManagedPublicHealth({
      probe: () => probePublicHealth(publicOrigin, config.realm.id),
      tunnelExitCode,
      onWaiting: (message) => {
        console.error(`Realm is locally ready; waiting for Quick Tunnel public health: ${message}`);
        console.error(`Realm URL (propagating): ${publicOrigin}`);
      },
    });
  } else {
    await waitForHealth(publicOrigin, config.realm.id, 45_000);
  }
  await rm(resolve(stateDir, "first-registration.url"), { force: true });
  const activeStage = `${activeRealmPath}.stage-${crypto.randomUUID()}`;
  try {
    await writeFile(activeStage, `${JSON.stringify({
      schemaVersion: runtimeRevision ? (forcedSshPublicOrigin ? 3 : 2) : 1,
      pid: process.pid,
      realmId: config.realm.id,
      localOrigin: gateway.endpoint,
      publicOrigin,
      registrationControlToken,
      ...(runtimeRevision ? { runtimeRevision } : {}),
      ...(runtimeRevision && forcedSshPublicOrigin ? { sshPublicOrigin: forcedSshPublicOrigin } : {}),
    })}\n`, { flag: "wx", mode: 0o600 });
    await rename(activeStage, activeRealmPath);
    await chmod(activeRealmPath, 0o600);
  } finally {
    await rm(activeStage, { force: true });
  }
  console.log("\nRealm ready");
  console.log(`Realm URL: ${publicOrigin}`);
  if (!workerMode) {
    const registrationUrl = await issueRegistrationUrl();
    console.log(`Registration URL (one use, expires in five minutes): ${registrationUrl}`);
  }
  console.log(`Registration URL command: start-realm registration-url ${configPath}`);
  console.log("Next steps:");
  console.log("  1. Open the registration URL now and create the first passkey.");
  console.log("  2. Sign in to the Realm URL.");
  if (config.desktop) console.log("  3. Choose Connect Desktop from the authenticated Realm menu.");
  console.log("Stop: Ctrl-C");
  if (tunnel) {
    void tunnel.exited.then(async (code) => {
      if (!stopping) {
        console.error(`cloudflared exited unexpectedly (${code})`);
        await stop();
        process.exit(code || 1);
      }
    });
  }
} catch (error) {
  await stop();
  throw error;
}
