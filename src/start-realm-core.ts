export type StartRealmConfig = Readonly<{
  schemaVersion: 1;
  realm: Readonly<{ id: string; name: string; canvasColor: string }>;
  port: number;
  stateDir: string;
  desktop?: Readonly<{ sshUrl: string }>;
}>;

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

const usage = "Usage: start-realm config.json | start-realm registration-url config.json";

export function parseStartRealmArgs(args: readonly string[]): StartRealmArgs {
  if (args.length === 1 && args[0] && args[0] !== "registration-url") return Object.freeze({ command: "run", configPath: args[0] });
  if (args.length === 2 && args[0] === "registration-url" && args[1]) {
    return Object.freeze({ command: "registration-url", configPath: args[1] });
  }
  throw new TypeError(usage);
}

export function parseActiveRealmRecord(value: unknown, realmId: string, port: number): ActiveRealmRecord {
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
  if (publicUrl.origin !== publicOrigin || publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password) invalid();
  return Object.freeze({
    schemaVersion: 1,
    pid: input.pid as number,
    realmId,
    localOrigin: input.localOrigin as string,
    publicOrigin,
    registrationControlToken: input.registrationControlToken as string,
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
  const allowed = input.desktop === undefined
    ? ["port", "realm", "schemaVersion", "stateDir"]
    : ["desktop", "port", "realm", "schemaVersion", "stateDir"];
  if (!exactKeys(input, allowed) || input.schemaVersion !== 1) invalid();
  if (!input.realm || typeof input.realm !== "object" || Array.isArray(input.realm)) invalid();
  const realm = input.realm as Record<string, unknown>;
  if (!exactKeys(realm, ["canvasColor", "id", "name"])
    || typeof realm.id !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(realm.id)
    || typeof realm.name !== "string" || realm.name.length < 1 || realm.name.length > 80
    || typeof realm.canvasColor !== "string" || !/^#[0-9a-f]{6}$/.test(realm.canvasColor)) invalid();
  if (!Number.isSafeInteger(input.port) || (input.port as number) < 1 || (input.port as number) > 65_535
    || typeof input.stateDir !== "string" || input.stateDir.length < 1 || input.stateDir.length > 1_024) invalid();
  let desktop: Readonly<{ sshUrl: string }> | undefined;
  if (input.desktop !== undefined) {
    if (!input.desktop || typeof input.desktop !== "object" || Array.isArray(input.desktop)) invalid();
    const candidate = input.desktop as Record<string, unknown>;
    if (!exactKeys(candidate, ["sshUrl"])) invalid();
    const sshUrl = candidate.sshUrl;
    if (typeof sshUrl !== "string") throw new TypeError("start-realm config is invalid");
    let url: URL;
    try { url = new URL(sshUrl); } catch { throw new TypeError("Desktop SSH URL must use ssh://"); }
    if (url.protocol !== "ssh:" || url.username === "" || url.hostname === "" || url.password !== "") {
      throw new TypeError("Desktop SSH URL must use ssh:// without a password");
    }
    desktop = Object.freeze({ sshUrl: url.href });
  }
  return Object.freeze({
    schemaVersion: 1,
    realm: Object.freeze({ id: realm.id as string, name: realm.name as string, canvasColor: realm.canvasColor as string }),
    port: input.port as number,
    stateDir: input.stateDir as string,
    ...(desktop ? { desktop } : {}),
  });
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
