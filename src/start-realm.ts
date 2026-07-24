import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadPublishedAppV2, resolvePublishedAppV2Root } from "./app-launcher";
import { createPasskeyAuth, createRealmGateway } from "./server";
import { parseQuickTunnelUrl, parseStartRealmConfig, resolveCloudflaredAsset } from "./start-realm-core";

const configArgument = process.argv[2];
if (!configArgument || process.argv.length !== 3) {
  console.error("Usage: start-realm config.json");
  process.exit(2);
}

const configPath = resolve(configArgument);
const config = parseStartRealmConfig(JSON.parse(await readFile(configPath, "utf8")));
const stateDir = resolve(dirname(configPath), config.stateDir);
await mkdir(stateDir, { recursive: true, mode: 0o700 });
await chmod(stateDir, 0o700);

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
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

let tunnel: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
let gateway: ReturnType<typeof createRealmGateway> | undefined;
let auth: ReturnType<typeof createPasskeyAuth> | undefined;
let stopping: Promise<void> | undefined;
async function stop(): Promise<void> {
  if (stopping) return stopping;
  stopping = (async () => {
    gateway?.stop();
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

try {
  const executable = await cloudflaredPath();
  tunnel = Bun.spawn([
    executable,
    "tunnel",
    "--config", "/dev/null",
    "--no-autoupdate",
    "--url", `http://127.0.0.1:${config.port}`,
  ], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const publicOrigin = await captureTunnelOrigin(tunnel);
  const branding = Object.freeze({ canvasColor: config.realm.canvasColor });
  const appRoot = await resolvePublishedAppV2Root(resolve(import.meta.dir, "../app-v2"));
  const appV2 = await loadPublishedAppV2(appRoot);
  auth = createPasskeyAuth({
    branding,
    databasePath: resolve(stateDir, "auth.sqlite"),
    realmId: config.realm.id,
    realmName: config.realm.name,
    publicOrigin,
    rpId: new URL(publicOrigin).hostname,
  });
  gateway = createRealmGateway({
    branding,
    hostname: "127.0.0.1",
    port: config.port,
    realmId: config.realm.id,
    name: config.realm.name,
    authorityEpoch: `${config.realm.id}-1`,
    generation: `${config.realm.id}-1`,
    capabilities: ["realm:view"],
    publicBindingCapabilities: ["realm:view"],
    appV2,
    auth,
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
  const registrationFile = resolve(stateDir, "first-registration.url");
  await writeFile(registrationFile, `${gateway.issueRegistrationUrl()}\n`, { mode: 0o600 });
  await chmod(registrationFile, 0o600);
  await waitForHealth(gateway.endpoint, config.realm.id, 10_000);
  await waitForHealth(publicOrigin, config.realm.id, 45_000);
  console.log("\nRealm ready");
  console.log(`Realm URL: ${publicOrigin}`);
  console.log(`First registration file: ${registrationFile}`);
  if (config.desktop) console.log(`Connect Desktop SSH URL: ${config.desktop.sshUrl}`);
  console.log("Stop: Ctrl-C");
  void tunnel.exited.then(async (code) => {
    if (!stopping) {
      console.error(`cloudflared exited unexpectedly (${code})`);
      await stop();
      process.exit(code || 1);
    }
  });
} catch (error) {
  await stop();
  throw error;
}
