import { createHash } from "node:crypto";
import { isIP } from "node:net";

export type StartRealmConfig = Readonly<{
  schemaVersion: 1;
  realm: Readonly<{ id: string; name: string; canvasColor: string }>;
  port: number;
  stateDir: string;
  gateways?: Readonly<Record<string, GatewayMountConfig>>;
  publicOrigin?: string;
  desktop?: Readonly<{
    ssh: Readonly<{ host: string; port: number; user: string; startingDirectory: string }>;
  }>;
}>;

export type GatewayPackageLocator = Readonly<{
  repository: string;
  commit: string;
  packagePath: string;
}>;

export type GatewayMountConfig = Readonly<{
  source: string;
  baseRoute: string;
  storageSubdir: string;
  config: Readonly<Record<string, unknown>>;
}>;

export type StartRealmTunnelPlan = Readonly<{ mode: "managed" }>
  | Readonly<{ mode: "external"; publicOrigin: string }>;

export type CloudflaredAsset = Readonly<{ version: string; url: string; sha256: string }>;
export type StartRealmArgs = Readonly<{ command: "run" | "registration-url"; configPath: string }>;
export type ActiveRealmRecord = Readonly<{
  schemaVersion: 1 | 2 | 3;
  pid: number;
  realmId: string;
  localOrigin: string;
  publicOrigin: string;
  registrationControlToken: string;
  runtimeRevision?: string;
  sshPublicOrigin?: string;
}>;
export type ManagedTunnelRecord = Readonly<{
  schemaVersion: 1;
  pid: number;
  realmId: string;
  localOrigin: string;
  publicOrigin: string;
  sessionName: string;
}>;
export type ActiveSshRelayRecord = Readonly<{
  schemaVersion: 1 | 2;
  pid: number;
  realmId: string;
  localOrigin: string;
  sessionName: string;
  configRevision?: string;
  realmPublicOrigin?: string;
}>;

const START_REALM_FAILURE_LIMIT = 16 * 1024;

function redactStartRealmFailure(value: string): string {
  return value
    .replace(/\b(token|secret|password|authorization|cookie)(\s*[:=]\s*)([^\s]+)/giu, "$1$2[REDACTED]")
    .replace(/([?&#](?:token|secret|password|authorization|cookie)=)[^&#\s]*/giu, "$1[REDACTED]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "?");
}

function renderStartRealmFailure(error: unknown, depth: number, seen: Set<unknown>): readonly string[] {
  const indent = "  ".repeat(depth);
  if (depth > 8) return [`${indent}[nested failure depth exceeded]`];
  if (error && typeof error === "object") {
    if (seen.has(error)) return [`${indent}[cyclic failure]`];
    seen.add(error);
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "start-realm failed";
  const lines = [ `${indent}${message || error?.constructor?.name || "start-realm failed"}` ];
  if (error instanceof AggregateError) {
    const nested = [...error.errors].slice(0, 16);
    nested.forEach((failure, index) => {
      lines.push(`${indent}  Cause ${index + 1}:`);
      lines.push(...renderStartRealmFailure(failure, depth + 2, seen));
    });
    if (error.errors.length > nested.length) lines.push(`${indent}  [additional causes omitted]`);
  }
  return lines;
}

export function formatStartRealmFailure(error: unknown): string {
  const rendered = redactStartRealmFailure(renderStartRealmFailure(error, 0, new Set()).join("\n"));
  if (rendered.length <= START_REALM_FAILURE_LIMIT) return rendered;
  const suffix = "\n[start-realm failure output truncated]";
  return `${rendered.slice(0, START_REALM_FAILURE_LIMIT - suffix.length)}${suffix}`;
}

export function formatRegistrationUrlBlock(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("registration URL must be a safe single-line HTTPS URL");
  }
  if (value.length < 1 || value.length > 4096 || parsed.protocol !== "https:" || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error("registration URL must be a safe single-line HTTPS URL");
  }
  const rule = "=".repeat(72);
  return [
    "",
    rule,
    "!!!              ACTION REQUIRED: REGISTER THIS REALM NOW              !!!",
    rule,
    "",
    value,
    "",
    rule,
    "!!!                 ONE USE • EXPIRES IN 5 MINUTES                    !!!",
    rule,
    "",
  ].join("\n");
}

export function renderLoopbackSshdDropIn(user: string, authorizedKeysFile: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(user)
    || !authorizedKeysFile.startsWith("/")
    || /[\u0000-\u0020\u007f-\u009f]/u.test(authorizedKeysFile)) {
    throw new Error("invalid loopback SSH Gateway configuration");
  }
  return [
    `Match User ${user} LocalAddress 127.0.0.1`,
    `    AuthorizedKeysFile .ssh/authorized_keys ${authorizedKeysFile}`,
    "Match all",
    "",
  ].join("\n");
}

export function isManagedLoopbackSshdDropIn(value: string, user: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(user) || value.length > 4_096) return false;
  const lines = value.split("\n");
  if (lines.length !== 4
    || lines[0] !== `Match User ${user} LocalAddress 127.0.0.1`
    || lines[2] !== "Match all" || lines[3] !== "") return false;
  const prefix = "    AuthorizedKeysFile .ssh/authorized_keys ";
  if (!lines[1]?.startsWith(prefix)) return false;
  const authorizedKeysFile = lines[1].slice(prefix.length);
  return authorizedKeysFile.startsWith("/")
    && authorizedKeysFile.endsWith("/desktop-authorized-keys")
    && !/[\u0000-\u0020\u007f-\u009f]/u.test(authorizedKeysFile);
}

export function managedSshdDropInStatIsSafe(value: string): boolean {
  const [rawMode, rawUid, rawSize, ...extra] = value.trimEnd().split("\n");
  if (extra.length !== 0 || !rawMode || !/^[0-9a-f]+$/u.test(rawMode)
    || !rawUid || !/^[0-9]+$/u.test(rawUid) || !rawSize || !/^[0-9]+$/u.test(rawSize)) return false;
  const mode = Number.parseInt(rawMode, 16);
  const size = Number(rawSize);
  return (mode & 0o170000) === 0o100000 && (mode & 0o022) === 0
    && rawUid === "0" && Number.isSafeInteger(size) && size > 0 && size <= 4_096;
}

export function effectiveSshdUsesAuthorizedKeysFile(output: string, authorizedKeysFile: string): boolean {
  return output.split(/\r?\n/u).some((line) => {
    const fields = line.trim().split(/\s+/u);
    return fields[0]?.toLowerCase() === "authorizedkeysfile" && fields.slice(1).includes(authorizedKeysFile);
  });
}

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

export function parseActiveRealmRecord(
  value: unknown,
  realmId: string,
  port: number,
  expectedPublicOrigin?: string,
  expectedSshPublicOrigin?: string | null,
): ActiveRealmRecord {
  const invalid = (): never => { throw new TypeError("active Realm record is invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  const expectedKeys = input.schemaVersion === 3
    ? ["localOrigin", "pid", "publicOrigin", "realmId", "registrationControlToken", "runtimeRevision", "schemaVersion", "sshPublicOrigin"]
    : input.schemaVersion === 2
      ? ["localOrigin", "pid", "publicOrigin", "realmId", "registrationControlToken", "runtimeRevision", "schemaVersion"]
      : ["localOrigin", "pid", "publicOrigin", "realmId", "registrationControlToken", "schemaVersion"];
  if (!exactKeys(input, expectedKeys)
    || (input.schemaVersion !== 1 && input.schemaVersion !== 2 && input.schemaVersion !== 3) || input.realmId !== realmId
    || !Number.isSafeInteger(input.pid) || (input.pid as number) < 1
    || input.localOrigin !== `http://127.0.0.1:${port}`
    || typeof input.publicOrigin !== "string"
    || typeof input.registrationControlToken !== "string"
    || (input.schemaVersion !== 1 && (typeof input.runtimeRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.runtimeRevision)))
    || (input.schemaVersion === 3 && typeof input.sshPublicOrigin !== "string")
    || !/^[A-Za-z0-9_-]{43}$/.test(input.registrationControlToken)) invalid();
  const publicOrigin = input.publicOrigin as string;
  if (typeof publicOrigin !== "string") invalid();
  const publicUrl = (() => {
    try { return new URL(publicOrigin); } catch { return invalid(); }
  })();
  if (publicUrl.origin !== publicOrigin || publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password
    || (expectedPublicOrigin !== undefined && publicOrigin !== expectedPublicOrigin)) invalid();
  let sshPublicOrigin: string | undefined;
  if (input.schemaVersion === 3) {
    sshPublicOrigin = input.sshPublicOrigin as string;
    let sshPublicUrl: URL;
    try { sshPublicUrl = new URL(sshPublicOrigin); } catch { return invalid(); }
    if (sshPublicUrl.origin !== sshPublicOrigin || sshPublicUrl.protocol !== "https:" || sshPublicUrl.username || sshPublicUrl.password) invalid();
  }
  if (expectedSshPublicOrigin === null ? sshPublicOrigin !== undefined
    : expectedSshPublicOrigin !== undefined && sshPublicOrigin !== expectedSshPublicOrigin) invalid();
  return Object.freeze({
    schemaVersion: input.schemaVersion as 1 | 2 | 3,
    pid: input.pid as number,
    realmId,
    localOrigin: input.localOrigin as string,
    publicOrigin,
    registrationControlToken: input.registrationControlToken as string,
    ...(input.schemaVersion !== 1 ? { runtimeRevision: input.runtimeRevision as string } : {}),
    ...(input.schemaVersion === 3 ? { sshPublicOrigin } : {}),
  });
}

export function desktopSshRelayPort(realmPort: number): number {
  if (!Number.isSafeInteger(realmPort) || realmPort < 1 || realmPort > 65_535) throw new TypeError("Realm port is invalid");
  return realmPort === 65_535 ? 65_534 : realmPort + 1;
}

export function startRealmSessionNames(realmId: string, stateDir: string): Readonly<{
  tunnel: string;
  realm: string;
  sshTunnel: string;
  sshRelay: string;
}> {
  const identity = createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  const prefix = `klivcore-${realmId}-${identity}`;
  return Object.freeze({
    tunnel: `${prefix}-tunnel`,
    realm: `${prefix}-realm`,
    sshTunnel: `${prefix}-ssh-tunnel`,
    sshRelay: `${prefix}-ssh-relay`,
  });
}

export function tmuxStopResultIsSafe(exitCode: number, sessionStillExists: boolean): boolean {
  return exitCode === 0 || !sessionStillExists;
}

export function isOwnedRealmWorkerCommand(
  argv: readonly string[],
  executablePath: string,
  workerPath: string,
  configPath: string,
): boolean {
  return argv.length === 3 && argv[0] === executablePath && argv[1] === workerPath && argv[2] === configPath;
}

export type ManagedProcessSnapshot = Readonly<{
  pid: number;
  startTimeTicks: string;
  uid: number;
  gid: number;
  argv: readonly string[];
}>;

export type ManagedProcessExpectation = Readonly<{
  pid?: number;
  uid: number;
  gid: number;
  argv: readonly string[];
}>;

export function isExactManagedProcess(
  snapshot: ManagedProcessSnapshot,
  expected: ManagedProcessExpectation,
  expectedStartTimeTicks?: string,
): boolean {
  return Number.isSafeInteger(snapshot.pid) && snapshot.pid > 0
    && /^(?:0|[1-9][0-9]*)$/u.test(snapshot.startTimeTicks)
    && (expected.pid === undefined || snapshot.pid === expected.pid)
    && (expectedStartTimeTicks === undefined || snapshot.startTimeTicks === expectedStartTimeTicks)
    && snapshot.uid === expected.uid && snapshot.gid === expected.gid
    && snapshot.argv.length === expected.argv.length
    && snapshot.argv.every((argument, index) => argument === expected.argv[index]);
}

export function isCompatibleManagedWorkerForReuse(
  snapshot: ManagedProcessSnapshot,
  expected: ManagedProcessExpectation,
): boolean {
  if (isExactManagedProcess(snapshot, expected)) return true;
  if (expected.pid === undefined || snapshot.pid !== expected.pid
    || !/^(?:0|[1-9][0-9]*)$/u.test(snapshot.startTimeTicks)
    || snapshot.uid !== expected.uid || snapshot.gid !== expected.gid
    || snapshot.argv.length !== 3 || expected.argv.length !== 3
    || snapshot.argv[0] !== expected.argv[0] || snapshot.argv[2] !== expected.argv[2]) return false;
  const marker = "/node_modules/";
  const snapshotMarker = snapshot.argv[1]!.lastIndexOf(marker);
  const expectedMarker = expected.argv[1]!.lastIndexOf(marker);
  if (snapshotMarker < 0 || expectedMarker < 0) return false;
  const snapshotWorker = snapshot.argv[1]!.slice(snapshotMarker + marker.length);
  const expectedWorker = expected.argv[1]!.slice(expectedMarker + marker.length);
  if (snapshotWorker === expectedWorker) return true;
  return snapshotWorker === "start-realm/src/start-realm.ts"
    && expectedWorker === "@klivcore/sdk-v1/src/start-realm.ts";
}

export function isStaleManagedRealmWorker(
  snapshot: ManagedProcessSnapshot,
  identity: Readonly<{ uid: number; gid: number; executablePath: string }>,
  environment: Readonly<Record<string, string>>,
  realmId: string,
  sessionName: string,
  mode: "realm" | "tunnel" | "ssh-tunnel" | "ssh-relay",
): boolean {
  const prefix = `klivcore-${realmId}-`;
  const suffix = `-${mode}`;
  const hash = sessionName.startsWith(prefix) && sessionName.endsWith(suffix)
    ? sessionName.slice(prefix.length, -suffix.length) : "";
  if (!/^[a-f0-9]{12}$/u.test(hash)
    || snapshot.uid !== identity.uid || snapshot.gid !== identity.gid
    || snapshot.argv.length !== 3 || snapshot.argv[0] !== identity.executablePath
    || !snapshot.argv[1] || !snapshot.argv[2]?.startsWith("/")
    || /[\u0000-\u001f\u007f]/u.test(snapshot.argv[2])
    || environment.KLIVCORE_START_REALM_MODE !== mode) return false;
  if ((mode === "tunnel" || mode === "ssh-tunnel")
    && environment.KLIVCORE_START_REALM_TUNNEL_SESSION !== sessionName) return false;
  if (mode === "ssh-relay" && environment.KLIVCORE_START_REALM_SSH_RELAY_SESSION !== sessionName) return false;
  const marker = "/node_modules/";
  const markerIndex = snapshot.argv[1].lastIndexOf(marker);
  if (markerIndex < 0) return false;
  return [
    "sdk-v1/src/start-realm.ts",
    "@klivcore/sdk-v1/src/start-realm.ts",
    "start-realm/src/start-realm.ts",
  ].includes(snapshot.argv[1].slice(markerIndex + marker.length));
}

export function isStaleManagedSshRelayWorker(
  snapshot: ManagedProcessSnapshot,
  identity: Readonly<{ uid: number; gid: number; executablePath: string }>,
  environment: Readonly<Record<string, string>>,
  realmId: string,
  sessionName: string,
): boolean {
  return isStaleManagedRealmWorker(snapshot, identity, environment, realmId, sessionName, "ssh-relay");
}

export function priorRealmDirectorySessionMode(
  sessionName: string,
  realmId: string,
): "realm" | "tunnel" | "ssh-relay" | "ssh-tunnel" | undefined {
  const prefix = `klivcore-${realmId}-`;
  if (!sessionName.startsWith(prefix)) return undefined;
  for (const mode of ["ssh-tunnel", "ssh-relay", "tunnel", "realm"] as const) {
    const suffix = `-${mode}`;
    if (!sessionName.endsWith(suffix)) continue;
    const layoutHash = sessionName.slice(prefix.length, -suffix.length);
    return /^[a-f0-9]{12}$/u.test(layoutHash) ? mode : undefined;
  }
  return undefined;
}

export type ManagedProcessTerminationOperations = Readonly<{
  read: (pid: number) => Promise<ManagedProcessSnapshot | undefined>;
  signal: (pid: number, signal: "TERM" | "KILL") => Promise<void>;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
}>;

export async function terminateExactManagedProcess(
  initial: ManagedProcessSnapshot,
  expected: ManagedProcessExpectation,
  operations: ManagedProcessTerminationOperations,
  timings: Readonly<{ gracefulMs: number; forceMs: number; pollMs: number }> = Object.freeze({ gracefulMs: 5_000, forceMs: 2_000, pollMs: 100 }),
): Promise<void> {
  const bound = Object.freeze({ ...expected, pid: initial.pid });
  if (!isExactManagedProcess(initial, bound)) throw new Error("refusing to signal an unverified managed process");
  await operations.signal(initial.pid, "TERM");
  const gracefulDeadline = operations.now() + timings.gracefulMs;
  let current = await operations.read(initial.pid);
  while (current && current.startTimeTicks === initial.startTimeTicks && operations.now() < gracefulDeadline) {
    await operations.sleep(timings.pollMs);
    current = await operations.read(initial.pid);
  }
  if (current && current.startTimeTicks !== initial.startTimeTicks) throw new Error("refusing to signal a reused managed PID");
  if (!current) return;
  if (!isExactManagedProcess(current, bound, initial.startTimeTicks)) throw new Error("refusing to force-stop changed managed process identity");
  await operations.signal(initial.pid, "KILL");
  const forceDeadline = operations.now() + timings.forceMs;
  do {
    await operations.sleep(Math.min(timings.pollMs, 50));
    current = await operations.read(initial.pid);
    if (current && current.startTimeTicks !== initial.startTimeTicks) throw new Error("managed PID was reused during termination");
  } while (current && operations.now() < forceDeadline);
  if (current) throw new Error("owned managed process did not exit");
}

export async function failAfterRollbackOperations(
  primaryError: unknown,
  label: string,
  operations: readonly (() => Promise<void>)[],
): Promise<never> {
  const failures: unknown[] = [primaryError];
  for (const operation of operations) {
    try { await operation(); } catch (error) { failures.push(error); }
  }
  if (failures.length > 1) throw new AggregateError(failures, label);
  throw primaryError;
}

export function parseActiveSshRelayRecord(
  value: unknown,
  realmId: string,
  port: number,
  sessionName: string,
  expectedConfigRevision?: string,
  expectedRealmPublicOrigin?: string,
): ActiveSshRelayRecord {
  const invalid = (): never => { throw new TypeError("active SSH relay record is invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  const expectedKeys = input.schemaVersion === 2
    ? ["configRevision", "localOrigin", "pid", "realmId", "realmPublicOrigin", "schemaVersion", "sessionName"]
    : ["localOrigin", "pid", "realmId", "schemaVersion", "sessionName"];
  if (!exactKeys(input, expectedKeys)
    || (input.schemaVersion !== 1 && input.schemaVersion !== 2) || input.realmId !== realmId || input.sessionName !== sessionName
    || !Number.isSafeInteger(input.pid) || (input.pid as number) < 1
    || input.localOrigin !== `http://127.0.0.1:${port}`
    || (input.schemaVersion === 2 && (typeof input.configRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.configRevision)
      || typeof input.realmPublicOrigin !== "string"))) invalid();
  if (expectedConfigRevision !== undefined && input.configRevision !== expectedConfigRevision) invalid();
  if (expectedRealmPublicOrigin !== undefined && input.realmPublicOrigin !== expectedRealmPublicOrigin) invalid();
  return Object.freeze({
    schemaVersion: input.schemaVersion as 1 | 2,
    pid: input.pid as number,
    realmId,
    localOrigin: input.localOrigin as string,
    sessionName,
    ...(input.schemaVersion === 2 ? {
      configRevision: input.configRevision as string,
      realmPublicOrigin: input.realmPublicOrigin as string,
    } : {}),
  });
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

const gatewayMountKeyPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const gatewayRoutePattern = /^\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;
const gatewayStoragePattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)*$/;

export function parseGatewayPackageLocator(value: unknown): GatewayPackageLocator {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || /[\u0000-\u0020\u007f]/u.test(value)) throw new TypeError("Gateway package locator is invalid");
  const match = /^git\+(https:\/\/[^#]+\.git)#([a-f0-9]{40})::(.+)$/.exec(value);
  if (!match) throw new TypeError("Gateway package locator is invalid");
  let repository: URL;
  try { repository = new URL(match[1]!); } catch { throw new TypeError("Gateway package locator is invalid"); }
  if (repository.protocol !== "https:" || repository.username || repository.password || repository.search || repository.hash
    || repository.pathname === "/" || !repository.pathname.endsWith(".git")) throw new TypeError("Gateway package locator is invalid");
  const packagePath = match[3]!;
  if (packagePath.length > 1_024 || packagePath.startsWith("/") || packagePath.includes("\\")
    || packagePath.split("/").some((part) => !part || part === "." || part === ".." || !/^[A-Za-z0-9._~-]+$/.test(part))) throw new TypeError("Gateway package locator is invalid");
  return Object.freeze({ repository: repository.toString(), commit: match[2]!, packagePath });
}

function cloneGatewayConfig(value: unknown): Readonly<Record<string, unknown>> {
  const invalid = (): never => { throw new TypeError("start-realm config is invalid"); };
  let nodes = 0;
  const clone = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 2_048 || depth > 16) invalid();
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : invalid();
    if (Array.isArray(candidate)) return Object.freeze(candidate.map((entry) => clone(entry, depth + 1)));
    if (!candidate || typeof candidate !== "object") invalid();
    const record = candidate as Record<string, unknown>;
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(record)) {
      if (!key || key.length > 128 || key === "__proto__" || key === "constructor" || key === "prototype") invalid();
      output[key] = clone(record[key], depth + 1);
    }
    return Object.freeze(output);
  };
  const cloned = clone(value, 0);
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)
    || Buffer.byteLength(JSON.stringify(cloned), "utf8") > 64 * 1024) invalid();
  return cloned as Readonly<Record<string, unknown>>;
}

export function parseStartRealmConfig(value: unknown): StartRealmConfig {
  const invalid = (): never => { throw new TypeError("start-realm config is invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  const allowed = [
    ...(input.desktop === undefined ? [] : ["desktop"]),
    ...(input.gateways === undefined ? [] : ["gateways"]),
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
  let gateways: StartRealmConfig["gateways"];
  if (input.gateways !== undefined) {
    if (!input.gateways || typeof input.gateways !== "object" || Array.isArray(input.gateways)) invalid();
    const entries = Object.entries(input.gateways as Record<string, unknown>);
    if (entries.length < 1 || entries.length > 32) invalid();
    const parsed: Record<string, GatewayMountConfig> = Object.create(null);
    for (const [key, raw] of entries) {
      if (!gatewayMountKeyPattern.test(key)) invalid();
      const candidate = typeof raw === "string" ? { source: raw } : raw;
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) invalid();
      const mount = candidate as Record<string, unknown>;
      const expected = [
        "source",
        ...(mount.baseRoute === undefined ? [] : ["baseRoute"]),
        ...(mount.storageSubdir === undefined ? [] : ["storageSubdir"]),
        ...(mount.config === undefined ? [] : ["config"]),
      ];
      if (!exactKeys(mount, expected)) invalid();
      parseGatewayPackageLocator(mount.source);
      const rawBaseRoute = mount.baseRoute ?? `/${key}`;
      const rawStorageSubdir = mount.storageSubdir ?? key;
      if (typeof rawBaseRoute !== "string" || !gatewayRoutePattern.test(rawBaseRoute)
        || typeof rawStorageSubdir !== "string" || !gatewayStoragePattern.test(rawStorageSubdir)) invalid();
      const baseRoute = rawBaseRoute as string;
      const storageSubdir = rawStorageSubdir as string;
      parsed[key] = Object.freeze({
        source: mount.source as string,
        baseRoute,
        storageSubdir,
        config: cloneGatewayConfig(mount.config ?? {}),
      });
    }
    const mounts = Object.values(parsed);
    if (mounts.some((mount, index) => mounts.some((candidate, candidateIndex) => candidateIndex < index
      && (mount.baseRoute === candidate.baseRoute || mount.baseRoute.startsWith(`${candidate.baseRoute}/`)
        || candidate.baseRoute.startsWith(`${mount.baseRoute}/`))))) invalid();
    if (new Set(mounts.map((mount) => mount.storageSubdir)).size !== mounts.length) invalid();
    gateways = Object.freeze(parsed);
  }
  return Object.freeze({
    schemaVersion: 1,
    realm: Object.freeze({ id: realm.id as string, name: realm.name as string, canvasColor: realm.canvasColor as string }),
    port: input.port as number,
    stateDir: input.stateDir as string,
    ...(gateways ? { gateways } : {}),
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

async function runBoundedCurl(arguments_: readonly string[], label: string): Promise<string> {
  const child = Bun.spawn([
    "curl",
    "--silent",
    "--show-error",
    "--fail",
    "--max-time", "10",
    "--max-filesize", "4096",
    "--proto", "=https",
    "--noproxy", "*",
    ...arguments_,
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
    throw new Error(stderr.trim() || stdout.trim() || `${label} exited ${exitCode}`);
  }
  return stdout;
}

export function parseDnsOverHttpsIpv4Answers(value: unknown, hostname: string): readonly string[] {
  if (!value || typeof value !== "object" || (value as { Status?: unknown }).Status !== 0) {
    throw new Error(`DNS-over-HTTPS did not resolve ${hostname}`);
  }
  const answer = (value as { Answer?: unknown }).Answer;
  if (!Array.isArray(answer) || answer.length > 32) throw new Error(`DNS-over-HTTPS did not resolve ${hostname}`);
  const expectedName = hostname.toLowerCase();
  const addresses = answer.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { name, type, data } = entry as { name?: unknown; type?: unknown; data?: unknown };
    return typeof name === "string" && name.toLowerCase().replace(/\.$/u, "") === expectedName && type === 1 && typeof data === "string" && isIP(data) === 4
      ? [data]
      : [];
  });
  const unique = [...new Set(addresses)].slice(0, 8);
  if (unique.length === 0) throw new Error(`DNS-over-HTTPS did not resolve ${hostname}`);
  return unique;
}

async function probeHealthWithDnsOverHttps(origin: string, realmId: string): Promise<void> {
  const url = new URL(origin);
  const lookupUrls = [
    `https://8.8.8.8/resolve?name=${encodeURIComponent(url.hostname)}&type=A`,
    `https://1.1.1.1/dns-query?name=${encodeURIComponent(url.hostname)}&type=A`,
  ];
  let addresses: readonly string[] | undefined;
  let lastLookupError: unknown;
  for (const lookupUrl of lookupUrls) {
    try {
      const dnsText = await runBoundedCurl([
        "--header", "accept: application/dns-json",
        lookupUrl,
      ], "DNS-over-HTTPS lookup");
      addresses = parseDnsOverHttpsIpv4Answers(JSON.parse(dnsText), url.hostname);
      break;
    } catch (error) {
      lastLookupError = error;
    }
  }
  if (!addresses) {
    throw lastLookupError instanceof Error ? lastLookupError : new Error("DNS-over-HTTPS lookup failed");
  }
  let lastError: unknown;
  for (const address of addresses) {
    try {
      const stdout = await runBoundedCurl([
        "--resolve", `${url.hostname}:${url.port || "443"}:${address}`,
        `${origin}/health`,
      ], "DNS-over-HTTPS health probe");
      let body: unknown;
      try {
        body = JSON.parse(stdout);
      } catch {
        throw new Error("DNS-over-HTTPS health probe returned invalid JSON");
      }
      if (!body || typeof body !== "object" || (body as { status?: unknown }).status !== "ok" || (body as { realmId?: unknown }).realmId !== realmId) {
        throw new Error("DNS-over-HTTPS health probe returned an unexpected Realm health response");
      }
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("DNS-over-HTTPS health probe failed");
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
