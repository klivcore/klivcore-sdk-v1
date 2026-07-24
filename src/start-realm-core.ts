import { createHash } from "node:crypto";
import { isIP } from "node:net";

export type StartRealmConfig = Readonly<{
  schemaVersion: 1;
  realm: Readonly<{ id: string; name: string; canvasColor: string }>;
  port: number;
  stateDir: string;
  publicOrigin?: string;
  desktop?: Readonly<{
    ssh: Readonly<{ host: string; port: number; user: string; startingDirectory: string }>;
  }>;
}>;

export type StartRealmTunnelPlan = Readonly<{ mode: "managed" }>
  | Readonly<{ mode: "external"; publicOrigin: string }>;

export type CloudflaredAsset = Readonly<{ version: string; url: string; sha256: string }>;
export type StartRealmArgs = Readonly<{ command: "run" | "registration-url"; configPath: string }>;
export type ActiveRealmRecord = Readonly<{
  schemaVersion: 1;
  pid: number;
  realmId: string;
  localOrigin: string;
  publicOrigin: string;
  registrationControlToken: string;
}>;
export type ManagedTunnelRecord = Readonly<{
  schemaVersion: 1;
  pid: number;
  realmId: string;
  localOrigin: string;
  publicOrigin: string;
  sessionName: string;
}>;

const usage = "Usage: start-realm config.json | start-realm registration-url config.json";

function validLauncherHost(host: string): boolean {
  if (host.length < 1 || host.length > 253 || /[\u0000-\u0020\u007f]/u.test(host)) return false;
  if (isIP(host) !== 0) return true;
  if (/^[0-9.]+$/.test(host)) return false;
  return host.split(".").every((label) => /^(?=.{1,63}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

export function parseStartRealmArgs(args: readonly string[]): StartRealmArgs {
  if (args.length === 1 && args[0] && args[0] !== "registration-url") return Object.freeze({ command: "run", configPath: args[0] });
  if (args.length === 2 && args[0] === "registration-url" && args[1]) {
    return Object.freeze({ command: "registration-url", configPath: args[1] });
  }
  throw new TypeError(usage);
}

export function parseActiveRealmRecord(value: unknown, realmId: string, port: number, expectedPublicOrigin?: string): ActiveRealmRecord {
  const invalid = (): never => { throw new TypeError("active Realm record is invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  if (!exactKeys(input, ["localOrigin", "pid", "publicOrigin", "realmId", "registrationControlToken", "schemaVersion"])
    || input.schemaVersion !== 1 || input.realmId !== realmId
    || !Number.isSafeInteger(input.pid) || (input.pid as number) < 1
    || input.localOrigin !== `http://127.0.0.1:${port}`
    || typeof input.publicOrigin !== "string"
    || typeof input.registrationControlToken !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(input.registrationControlToken)) invalid();
  const publicOrigin = input.publicOrigin as string;
  if (typeof publicOrigin !== "string") invalid();
  const publicUrl = (() => {
    try { return new URL(publicOrigin); } catch { return invalid(); }
  })();
  if (publicUrl.origin !== publicOrigin || publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password
    || (expectedPublicOrigin !== undefined && publicOrigin !== expectedPublicOrigin)) invalid();
  return Object.freeze({
    schemaVersion: 1,
    pid: input.pid as number,
    realmId,
    localOrigin: input.localOrigin as string,
    publicOrigin,
    registrationControlToken: input.registrationControlToken as string,
  });
}

export function startRealmSessionNames(realmId: string, stateDir: string): Readonly<{ tunnel: string; realm: string }> {
  const identity = createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  const prefix = `klivcore-${realmId}-${identity}`;
  return Object.freeze({ tunnel: `${prefix}-tunnel`, realm: `${prefix}-realm` });
}

export function parseManagedTunnelRecord(
  value: unknown,
  realmId: string,
  port: number,
  expectedSessionName: string,
): ManagedTunnelRecord {
  const invalid = (): never => { throw new TypeError("managed tunnel record is invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  if (!exactKeys(input, ["localOrigin", "pid", "publicOrigin", "realmId", "schemaVersion", "sessionName"])
    || input.schemaVersion !== 1 || input.realmId !== realmId
    || input.localOrigin !== `http://127.0.0.1:${port}`
    || !Number.isSafeInteger(input.pid) || (input.pid as number) < 1
    || input.sessionName !== expectedSessionName || typeof input.publicOrigin !== "string") invalid();
  const publicOrigin = input.publicOrigin as string;
  let url: URL;
  try { url = new URL(publicOrigin); } catch { return invalid(); }
  if (url.origin !== publicOrigin || url.protocol !== "https:" || url.username || url.password
    || !url.hostname.endsWith(".trycloudflare.com")) invalid();
  return Object.freeze({
    schemaVersion: 1,
    pid: input.pid as number,
    realmId,
    localOrigin: input.localOrigin as string,
    publicOrigin,
    sessionName: expectedSessionName,
  });
}

const cloudflaredVersion = "2026.7.3";
const assets: Readonly<Record<string, CloudflaredAsset>> = Object.freeze({
  "linux:x64": Object.freeze({
    version: cloudflaredVersion,
    url: `https://github.com/cloudflare/cloudflared/releases/download/${cloudflaredVersion}/cloudflared-linux-amd64`,
    sha256: "9d71c677db00134c1bd4144b7783486b654ad281b1ea62b4972098d19f770f17",
  }),
  "linux:arm64": Object.freeze({
    version: cloudflaredVersion,
    url: `https://github.com/cloudflare/cloudflared/releases/download/${cloudflaredVersion}/cloudflared-linux-arm64`,
    sha256: "65259e652a7bea08bf5df603233ab22b8bf3116af8df9f9206209af6a1b955c0",
  }),
});

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

export function parseStartRealmConfig(value: unknown): StartRealmConfig {
  const invalid = (): never => { throw new TypeError("start-realm config is invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  const allowed = [
    ...(input.desktop === undefined ? [] : ["desktop"]),
    "port",
    ...(input.publicOrigin === undefined ? [] : ["publicOrigin"]),
    "realm",
    "schemaVersion",
    "stateDir",
  ];
  if (!exactKeys(input, allowed) || input.schemaVersion !== 1) invalid();
  if (!input.realm || typeof input.realm !== "object" || Array.isArray(input.realm)) invalid();
  const realm = input.realm as Record<string, unknown>;
  if (!exactKeys(realm, ["canvasColor", "id", "name"])
    || typeof realm.id !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(realm.id)
    || typeof realm.name !== "string" || realm.name.length < 1 || realm.name.length > 80
    || typeof realm.canvasColor !== "string" || !/^#[0-9a-f]{6}$/.test(realm.canvasColor)) invalid();
  if (!Number.isSafeInteger(input.port) || (input.port as number) < 1 || (input.port as number) > 65_535
    || typeof input.stateDir !== "string" || input.stateDir.length < 1 || input.stateDir.length > 1_024) invalid();
  let publicOrigin: string | undefined;
  if (input.publicOrigin !== undefined) {
    if (typeof input.publicOrigin !== "string") invalid();
    try {
      const candidate = new URL(input.publicOrigin as string);
      if (candidate.protocol !== "https:" || candidate.origin !== input.publicOrigin
        || candidate.username || candidate.password || candidate.pathname !== "/" || candidate.search || candidate.hash) invalid();
      publicOrigin = candidate.origin;
    } catch { invalid(); }
  }
  let desktop: StartRealmConfig["desktop"];
  if (input.desktop !== undefined) {
    if (!input.desktop || typeof input.desktop !== "object" || Array.isArray(input.desktop)) invalid();
    const candidate = input.desktop as Record<string, unknown>;
    if (!exactKeys(candidate, ["ssh"]) || !candidate.ssh || typeof candidate.ssh !== "object" || Array.isArray(candidate.ssh)) invalid();
    const ssh = candidate.ssh as Record<string, unknown>;
    if (!exactKeys(ssh, ["host", "port", "startingDirectory", "user"])
      || typeof ssh.host !== "string" || !validLauncherHost(ssh.host)
      || !Number.isSafeInteger(ssh.port) || (ssh.port as number) < 1 || (ssh.port as number) > 65_535
      || typeof ssh.user !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(ssh.user)
      || typeof ssh.startingDirectory !== "string" || !ssh.startingDirectory.startsWith("/")
      || ssh.startingDirectory.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(ssh.startingDirectory)) invalid();
    const host = ssh.host as string;
    const user = ssh.user as string;
    const startingDirectory = ssh.startingDirectory as string;
    desktop = Object.freeze({
      ssh: Object.freeze({
        host,
        port: ssh.port as number,
        user,
        startingDirectory,
      }),
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    realm: Object.freeze({ id: realm.id as string, name: realm.name as string, canvasColor: realm.canvasColor as string }),
    port: input.port as number,
    stateDir: input.stateDir as string,
    ...(publicOrigin ? { publicOrigin } : {}),
    ...(desktop ? { desktop } : {}),
  });
}

export function planStartRealmTunnel(config: StartRealmConfig): StartRealmTunnelPlan {
  return config.publicOrigin
    ? Object.freeze({ mode: "external", publicOrigin: config.publicOrigin })
    : Object.freeze({ mode: "managed" });
}

export function resolveCloudflaredAsset(platform: string, arch: string): CloudflaredAsset {
  const asset = assets[`${platform}:${arch}`];
  if (!asset) throw new Error("start-realm currently supports Linux x64 and arm64");
  return asset;
}

export function parseQuickTunnelUrl(text: string): string | undefined {
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
  if (!match) return undefined;
  const url = new URL(match[0]);
  return url.protocol === "https:" && url.hostname.endsWith(".trycloudflare.com") ? url.origin : undefined;
}

export type ManagedPublicHealthWait = Readonly<{
  probe: () => Promise<void>;
  tunnelExitCode: () => number | null;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  retryDelayMs?: number;
  reportAfterMs?: number;
  reportEveryMs?: number;
  onWaiting?: (message: string) => void;
}>;

export async function waitForManagedPublicHealth(input: ManagedPublicHealthWait): Promise<void> {
  const sleep = input.sleep ?? Bun.sleep;
  const now = input.now ?? Date.now;
  const retryDelayMs = input.retryDelayMs ?? 500;
  const reportEveryMs = input.reportEveryMs ?? 30_000;
  let nextReportAt = now() + (input.reportAfterMs ?? 45_000);
  while (true) {
    const exitCode = input.tunnelExitCode();
    if (exitCode !== null) throw new Error(`cloudflared exited before public health was ready (${exitCode})`);
    try {
      await input.probe();
      return;
    } catch (error) {
      const current = now();
      if (current >= nextReportAt) {
        input.onWaiting?.(error instanceof Error ? error.message : String(error));
        nextReportAt = current + reportEveryMs;
      }
    }
    await sleep(retryDelayMs);
  }
}

const FRESH_BUN_HEALTH_PROBE = String.raw`
const [origin, realmId] = process.argv.slice(1);
try {
  const response = await fetch(origin + "/health", { signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  if (response.status !== 200 || body?.status !== "ok" || body?.realmId !== realmId) {
    throw new Error("unexpected Realm health response");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error && typeof error === "object" && "cause" in error && error.cause
    ? " (" + (error.cause.code ?? error.cause.message ?? String(error.cause)) + ")"
    : "";
  console.error(message + cause);
  process.exit(1);
}
`;

export async function probeHealthInFreshBun(origin: string, realmId: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "-e", FRESH_BUN_HEALTH_PROBE, origin, realmId], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `fresh Bun health probe exited ${exitCode}`);
  }
}

async function probeHealthWithDnsOverHttps(origin: string, realmId: string): Promise<void> {
  const child = Bun.spawn([
    "curl",
    "--silent",
    "--show-error",
    "--fail",
    "--max-time", "10",
    "--max-filesize", "4096",
    "--proto", "=https",
    "--doh-url", "https://1.1.1.1/dns-query",
    `${origin}/health`,
  ], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `DNS-over-HTTPS health probe exited ${exitCode}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new Error("DNS-over-HTTPS health probe returned invalid JSON");
  }
  if (!body || typeof body !== "object" || (body as { status?: unknown }).status !== "ok" || (body as { realmId?: unknown }).realmId !== realmId) {
    throw new Error("DNS-over-HTTPS health probe returned an unexpected Realm health response");
  }
}

export async function probePublicHealth(
  origin: string,
  realmId: string,
  probes: Readonly<{
    normalProbe?: (origin: string, realmId: string) => Promise<void>;
    dnsOverHttpsProbe?: (origin: string, realmId: string) => Promise<void>;
  }> = {},
): Promise<void> {
  const normalProbe = probes.normalProbe ?? probeHealthInFreshBun;
  const dnsOverHttpsProbe = probes.dnsOverHttpsProbe ?? probeHealthWithDnsOverHttps;
  try {
    await normalProbe(origin, realmId);
  } catch (normalError) {
    try {
      await dnsOverHttpsProbe(origin, realmId);
    } catch (dnsOverHttpsError) {
      const normalMessage = normalError instanceof Error ? normalError.message : String(normalError);
      const dnsOverHttpsMessage = dnsOverHttpsError instanceof Error ? dnsOverHttpsError.message : String(dnsOverHttpsError);
      throw new Error(`normal DNS health probe failed: ${normalMessage}; DNS-over-HTTPS fallback failed: ${dnsOverHttpsMessage}`);
    }
  }
}
