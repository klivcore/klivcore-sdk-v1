import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  mergeManagedSshConfig,
  parseConnectDesktopPackageSpec,
  parseDesktopPairingResponse,
  parseDesktopPairingUrl,
  preflightManagedSshConfig,
  renderManagedSshBlock,
  type DesktopPairingResponse,
} from "./connect-desktop-core";

type DesktopRelayProfile = DesktopPairingResponse & Readonly<{ relayToken: string }>;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const REALM_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  const uid = process.getuid?.();
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid)) {
    throw new Error(`Unsafe Desktop state directory: ${path}`);
  }
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function atomicPrivateWrite(path: string, content: string, mode = 0o600): Promise<void> {
  await privateDirectory(dirname(path));
  const stage = `${path}.stage-${randomUUID()}`;
  try {
    await writeFile(stage, content, { flag: "wx", mode });
    await rename(stage, path);
    if (process.platform !== "win32") await chmod(path, mode);
  } finally {
    await rm(stage, { force: true });
  }
}

type OptionalTextSnapshot = Readonly<{ exists: boolean; mode: number; text: string }>;

async function safeOptionalTextSnapshot(path: string, maxBytes: number): Promise<OptionalTextSnapshot> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return Object.freeze({ exists: false, mode: 0o600, text: "" });
  const uid = process.getuid?.();
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes || (uid !== undefined && info.uid !== uid)
    || (process.platform !== "win32" && (info.mode & 0o022) !== 0)) {
    throw new Error(`Unsafe existing file: ${path}`);
  }
  const bytes = await readFile(path);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`Unsafe existing file: ${path}`); }
  return Object.freeze({ exists: true, mode: info.mode & 0o777, text });
}

async function safeOptionalText(path: string, maxBytes: number): Promise<string> {
  return (await safeOptionalTextSnapshot(path, maxBytes)).text;
}

async function restoreOptionalText(path: string, snapshot: OptionalTextSnapshot): Promise<void> {
  if (snapshot.exists) await atomicPrivateWrite(path, snapshot.text, snapshot.mode);
  else await rm(path, { force: true });
}

async function boundedJsonResponse(response: Response, maxBytes = 8 * 1024): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const declared = response.headers.get("content-length");
  if (contentType !== "application/json" || (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Realm returned an invalid Desktop pairing response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error("Realm returned an invalid Desktop pairing response");
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("Realm returned an invalid Desktop pairing response"); }
}

function statePaths(home = homedir()) {
  const root = resolve(home, ".klivcore", "desktop");
  return Object.freeze({
    root,
    clientId: join(root, "client-id"),
    pairing: join(root, "pairing.json"),
    profiles: join(root, "profiles"),
    rotation: join(root, "rotation.json"),
    sshConfig: resolve(home, ".ssh", "config"),
  });
}

type PairingIntent = Readonly<{
  schemaVersion: 2;
  phase: "consume" | "rollback";
  origin: string;
  pairingToken: string;
  clientId: string;
  relayToken: string;
  packageSpec: string;
  previousClientId: OptionalTextSnapshot;
}>;

function parsePairingIntent(value: unknown): PairingIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Desktop pairing journal is invalid");
  const input = value as Record<string, unknown>;
  const previousClientId = parseSnapshot(input.previousClientId, 64);
  if (!exactKeys(input, ["clientId", "origin", "packageSpec", "pairingToken", "phase", "previousClientId", "relayToken", "schemaVersion"])
    || input.schemaVersion !== 2 || (input.phase !== "consume" && input.phase !== "rollback")
    || typeof input.origin !== "string" || typeof input.packageSpec !== "string"
    || typeof input.pairingToken !== "string" || typeof input.clientId !== "string" || typeof input.relayToken !== "string"
    || !previousClientId || !TOKEN_PATTERN.test(input.pairingToken)
    || !/^[a-f0-9-]{36}$/.test(input.clientId) || !TOKEN_PATTERN.test(input.relayToken)) {
    throw new Error("Desktop pairing journal is invalid");
  }
  const origin = new URL(input.origin);
  if (origin.protocol !== "https:" || origin.origin !== input.origin || origin.username || origin.password) throw new Error("Desktop pairing journal is invalid");
  return Object.freeze({
    schemaVersion: 2,
    phase: input.phase,
    origin: input.origin,
    pairingToken: input.pairingToken,
    clientId: input.clientId,
    relayToken: input.relayToken,
    packageSpec: parseConnectDesktopPackageSpec(input.packageSpec),
    previousClientId,
  });
}

type RotationJournal = Readonly<{
  schemaVersion: 2;
  phase: "forward" | "rollback";
  origin: string;
  clientId: string;
  relayToken: string;
  realmId: string;
  previousProfile: OptionalTextSnapshot;
  previousConfig: OptionalTextSnapshot;
  previousClientId: OptionalTextSnapshot;
  nextProfile: string;
  nextConfig: string;
}>;

function parseSnapshot(value: unknown, maxBytes: number): OptionalTextSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (!exactKeys(input, ["exists", "mode", "text"]) || typeof input.exists !== "boolean"
    || !Number.isSafeInteger(input.mode) || (input.mode as number) < 0 || (input.mode as number) > 0o777
    || typeof input.text !== "string" || Buffer.byteLength(input.text) > maxBytes
    || (!input.exists && (input.text !== "" || input.mode !== 0o600))) return undefined;
  return Object.freeze({ exists: input.exists, mode: input.mode as number, text: input.text });
}

function parseRotationJournal(value: unknown): RotationJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Desktop rotation journal is invalid");
  const input = value as Record<string, unknown>;
  const previousProfile = parseSnapshot(input.previousProfile, 8 * 1024);
  const previousConfig = parseSnapshot(input.previousConfig, 1024 * 1024);
  const previousClientId = parseSnapshot(input.previousClientId, 64);
  if (!exactKeys(input, ["clientId", "nextConfig", "nextProfile", "origin", "phase", "previousClientId", "previousConfig", "previousProfile", "realmId", "relayToken", "schemaVersion"])
    || input.schemaVersion !== 2 || (input.phase !== "forward" && input.phase !== "rollback")
    || typeof input.origin !== "string" || typeof input.clientId !== "string"
    || typeof input.relayToken !== "string" || typeof input.realmId !== "string" || typeof input.nextProfile !== "string"
    || typeof input.nextConfig !== "string" || Buffer.byteLength(input.nextProfile) > 8 * 1024
    || Buffer.byteLength(input.nextConfig) > 1024 * 1024 || !previousProfile || !previousConfig || !previousClientId
    || !/^[a-f0-9-]{36}$/.test(input.clientId) || !TOKEN_PATTERN.test(input.relayToken) || !REALM_ID_PATTERN.test(input.realmId)) {
    throw new Error("Desktop rotation journal is invalid");
  }
  const origin = new URL(input.origin);
  if (origin.protocol !== "https:" || origin.origin !== input.origin || origin.username || origin.password) throw new Error("Desktop rotation journal is invalid");
  return Object.freeze({
    schemaVersion: 2,
    phase: input.phase,
    origin: input.origin,
    clientId: input.clientId,
    relayToken: input.relayToken,
    realmId: input.realmId,
    previousProfile,
    previousConfig,
    previousClientId,
    nextProfile: input.nextProfile,
    nextConfig: input.nextConfig,
  });
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function postRelayOperation(fetcher: Fetcher, origin: string, path: string, clientId: string, relayToken: string): Promise<number | undefined> {
  try {
    const response = await fetcher(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, relayToken }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  } catch { return undefined; }
}

async function retryRelayOperation(fetcher: Fetcher, origin: string, path: string, clientId: string, relayToken: string): Promise<number | undefined> {
  let status: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    status = await postRelayOperation(fetcher, origin, path, clientId, relayToken);
    if (status !== undefined && status < 500) return status;
  }
  return status;
}

async function recoverRotation(paths: ReturnType<typeof statePaths>, fetcher: Fetcher): Promise<void> {
  const snapshot = await safeOptionalTextSnapshot(paths.rotation, 3 * 1024 * 1024);
  if (!snapshot.exists) return;
  let journal: RotationJournal;
  try { journal = parseRotationJournal(JSON.parse(snapshot.text)); }
  catch { throw new Error("Desktop rotation journal is invalid"); }
  const profilePath = join(paths.profiles, `${journal.realmId}.json`);
  const rollback = async () => {
    await restoreOptionalText(paths.sshConfig, journal.previousConfig);
    await restoreOptionalText(profilePath, journal.previousProfile);
    await restoreOptionalText(paths.clientId, journal.previousClientId);
    const revoked = await retryRelayOperation(fetcher, journal.origin, "/v1/desktop/pairing/revoke", journal.clientId, journal.relayToken);
    if (revoked !== 204) throw new Error("Desktop rotation rollback is unconfirmed");
    await rm(paths.rotation, { force: true });
    await rm(paths.pairing, { force: true });
  };
  if (journal.phase === "rollback") {
    await rollback();
    throw new Error("Recovered incomplete Desktop pairing rollback; prior connection restored");
  }
  await atomicPrivateWrite(paths.clientId, `${journal.clientId}\n`);
  await atomicPrivateWrite(profilePath, journal.nextProfile);
  await atomicPrivateWrite(paths.sshConfig, journal.nextConfig);
  const finalized = await retryRelayOperation(fetcher, journal.origin, "/v1/desktop/pairing/finalize", journal.clientId, journal.relayToken);
  if (finalized === 204) {
    await rm(paths.rotation, { force: true });
    await rm(paths.pairing, { force: true });
    return;
  }
  if (finalized === undefined) throw new Error("Desktop rotation recovery requires network access");
  journal = Object.freeze({ ...journal, phase: "rollback" });
  await atomicPrivateWrite(paths.rotation, `${JSON.stringify(journal)}\n`);
  await rollback();
  throw new Error("Desktop rotation could not be finalized; prior connection restored");
}


export async function pairDesktop(pairingUrl: string, options: Readonly<{
  home?: string;
  packageSpec: string;
  fetcher?: Fetcher;
  log?: (message: string) => void;
}>): Promise<void> {
  let target = parseDesktopPairingUrl(pairingUrl);
  let packageSpec = parseConnectDesktopPackageSpec(options.packageSpec);
  const paths = statePaths(options.home);
  const fetcher = options.fetcher ?? fetch;
  await privateDirectory(paths.root);
  await privateDirectory(paths.profiles);
  await recoverRotation(paths, fetcher);
  const existingConfigSnapshot = await safeOptionalTextSnapshot(paths.sshConfig, 1024 * 1024);
  const existingConfig = existingConfigSnapshot.text;
  preflightManagedSshConfig(existingConfig);
  const currentClientIdSnapshot = await safeOptionalTextSnapshot(paths.clientId, 64);
  const currentClientId = currentClientIdSnapshot.text.trim();
  if (currentClientId && !/^[a-f0-9-]{36}$/.test(currentClientId)) throw new Error("Desktop client identity is invalid");
  const existingIntentSnapshot = await safeOptionalTextSnapshot(paths.pairing, 4 * 1024);
  let clientId: string;
  let relayToken: string;
  let previousClientIdSnapshot: OptionalTextSnapshot;
  let pairingIntent: PairingIntent;
  if (existingIntentSnapshot.exists) {
    let intent: PairingIntent;
    try { intent = parsePairingIntent(JSON.parse(existingIntentSnapshot.text)); }
    catch { throw new Error("Desktop pairing journal is invalid"); }
    if (intent.phase === "rollback") {
      await restoreOptionalText(paths.clientId, intent.previousClientId);
      const revoked = await retryRelayOperation(fetcher, intent.origin, "/v1/desktop/pairing/revoke", intent.clientId, intent.relayToken);
      if (revoked !== 204) throw new Error("Desktop pairing rollback is unconfirmed");
      await rm(paths.pairing, { force: true });
      throw new Error("Recovered incomplete Desktop pairing rollback; prior client identity restored");
    }
    if ((currentClientId && intent.clientId !== currentClientId) || (!currentClientId && intent.previousClientId.exists)) {
      throw new Error("Desktop pairing journal is invalid");
    }
    pairingIntent = intent;
    clientId = intent.clientId;
    previousClientIdSnapshot = intent.previousClientId;
    if (!currentClientId) await atomicPrivateWrite(paths.clientId, `${clientId}\n`);
    target = Object.freeze({ origin: intent.origin, pairingToken: intent.pairingToken });
    packageSpec = intent.packageSpec;
    relayToken = intent.relayToken;
  } else {
    clientId = currentClientId || randomUUID();
    previousClientIdSnapshot = currentClientIdSnapshot;
    relayToken = randomBytes(32).toString("base64url");
    const intent: PairingIntent = Object.freeze({
      schemaVersion: 2,
      phase: "consume",
      origin: target.origin,
      pairingToken: target.pairingToken,
      clientId,
      relayToken,
      packageSpec,
      previousClientId: previousClientIdSnapshot,
    });
    pairingIntent = intent;
    await atomicPrivateWrite(paths.pairing, `${JSON.stringify(intent)}\n`);
    if (!currentClientId) await atomicPrivateWrite(paths.clientId, `${clientId}\n`);
  }
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2 && !response; attempt += 1) {
    try {
      const candidate = await fetcher(`${target.origin}/v1/desktop/pairing/consume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairingToken: target.pairingToken, clientId, relayToken }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (candidate.status >= 500) await candidate.body?.cancel().catch(() => undefined);
      else response = candidate;
    } catch { /* replay the exact journaled consume once */ }
  }
  if (!response) throw new Error("Desktop pairing outcome is indeterminate; rerun the command to recover");
  if (response.status !== 201) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) {
      await restoreOptionalText(paths.clientId, previousClientIdSnapshot);
      await rm(paths.pairing, { force: true });
    }
    throw new Error(response.status === 401 ? "Desktop pairing has expired or was already used" : "Realm refused Desktop pairing");
  }
  let metadata: DesktopPairingResponse;
  let profilePath: string | undefined;
  let previousProfile: OptionalTextSnapshot | undefined;
  let profileAttempted = false;
  let configAttempted = false;
  let finalizeIndeterminate = false;
  let rotationJournal: RotationJournal | undefined;
  try {
    metadata = parseDesktopPairingResponse(target.origin, await boundedJsonResponse(response));
    const managedBlock = renderManagedSshBlock({ realmId: metadata.realmId, sshUser: metadata.sshUser, packageSpec });
    const nextConfig = mergeManagedSshConfig(existingConfig, metadata.realmId, managedBlock);
    profilePath = join(paths.profiles, `${metadata.realmId}.json`);
    previousProfile = await safeOptionalTextSnapshot(profilePath, 8 * 1024);
    const profile: DesktopRelayProfile = Object.freeze({ ...metadata, relayToken });
    const nextProfile = `${JSON.stringify(profile, null, 2)}\n`;
    const journal: RotationJournal = Object.freeze({
      schemaVersion: 2,
      phase: "forward",
      origin: target.origin,
      clientId,
      relayToken,
      realmId: metadata.realmId,
      previousProfile,
      previousConfig: existingConfigSnapshot,
      previousClientId: previousClientIdSnapshot,
      nextProfile,
      nextConfig,
    });
    rotationJournal = journal;
    await atomicPrivateWrite(paths.rotation, `${JSON.stringify(journal)}\n`);
    await rm(paths.pairing, { force: true });
    profileAttempted = true;
    await atomicPrivateWrite(profilePath, nextProfile);
    configAttempted = true;
    await atomicPrivateWrite(paths.sshConfig, nextConfig);
    const finalized = await retryRelayOperation(fetcher, target.origin, "/v1/desktop/pairing/finalize", clientId, relayToken);
    if (finalized === undefined) {
      finalizeIndeterminate = true;
      throw new Error("Desktop pairing finalization is indeterminate; rerun the command to recover");
    }
    if (finalized !== 204) throw new Error("Realm refused Desktop pairing finalization");
    await rm(paths.rotation, { force: true });
    await rm(paths.pairing, { force: true });
  } catch (error) {
    if (finalizeIndeterminate) throw error;
    const failures: unknown[] = [error];
    if (rotationJournal) {
      try {
        rotationJournal = Object.freeze({ ...rotationJournal, phase: "rollback" });
        await atomicPrivateWrite(paths.rotation, `${JSON.stringify(rotationJournal)}\n`);
      } catch (journalError) {
        throw new AggregateError([error, journalError], "Desktop pairing rollback decision could not be persisted");
      }
    } else {
      try {
        pairingIntent = Object.freeze({ ...pairingIntent, phase: "rollback" });
        await atomicPrivateWrite(paths.pairing, `${JSON.stringify(pairingIntent)}\n`);
      } catch (journalError) {
        throw new AggregateError([error, journalError], "Desktop pairing rollback decision could not be persisted");
      }
    }
    if (configAttempted) {
      try { await restoreOptionalText(paths.sshConfig, existingConfigSnapshot); }
      catch (restoreError) { failures.push(restoreError); }
    }
    if (profileAttempted && profilePath && previousProfile) {
      try { await restoreOptionalText(profilePath, previousProfile); }
      catch (restoreError) { failures.push(restoreError); }
    }
    try { await restoreOptionalText(paths.clientId, previousClientIdSnapshot); }
    catch (restoreError) { failures.push(restoreError); }
    const revoked = await retryRelayOperation(fetcher, target.origin, "/v1/desktop/pairing/revoke", clientId, relayToken);
    if (revoked !== 204) failures.push(new Error("Realm did not confirm pending Desktop relay revocation"));
    if (failures.length === 1) {
      await rm(paths.rotation, { force: true });
      await rm(paths.pairing, { force: true });
    }
    if (failures.length > 1) throw new AggregateError(failures, "Desktop pairing rollback failed");
    throw error;
  }

  const alias = `klivcore-${metadata.realmId}`;
  const log = options.log ?? console.log;
  log(`Connected ${metadata.realmName} for Desktop.`);
  log(`SSH host: ${alias}`);
  log(`Hermes working directory: ${metadata.startingDirectory}`);
  log(`Test: ssh ${alias}`);
}

async function loadProfile(realmId: string): Promise<DesktopRelayProfile> {
  if (!REALM_ID_PATTERN.test(realmId)) throw new TypeError("Desktop relay profile is invalid");
  const path = join(statePaths().profiles, `${realmId}.json`);
  const info = await lstat(path);
  const uid = process.getuid?.();
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 8 * 1024
    || (uid !== undefined && info.uid !== uid) || (process.platform !== "win32" && (info.mode & 0o777) !== 0o600)) {
    throw new Error("Desktop relay profile is unsafe");
  }
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("Desktop relay profile is invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Desktop relay profile is invalid");
  const input = value as Record<string, unknown>;
  if (!exactKeys(input, ["realmId", "realmName", "relayToken", "relayUrl", "schemaVersion", "sshUser", "startingDirectory"])
    || typeof input.relayToken !== "string" || !TOKEN_PATTERN.test(input.relayToken)
    || typeof input.relayUrl !== "string") throw new Error("Desktop relay profile is invalid");
  let publicOrigin: string;
  try { publicOrigin = new URL(input.relayUrl).origin.replace(/^wss:/, "https:"); }
  catch { throw new Error("Desktop relay profile is invalid"); }
  const metadata = parseDesktopPairingResponse(publicOrigin, {
    schemaVersion: input.schemaVersion,
    realmId: input.realmId,
    realmName: input.realmName,
    relayUrl: input.relayUrl,
    sshUser: input.sshUser,
    startingDirectory: input.startingDirectory,
  });
  if (metadata.realmId !== realmId) throw new Error("Desktop relay profile is invalid");
  return Object.freeze({ ...metadata, relayToken: input.relayToken });
}

type DrainEmitter = Readonly<{
  off(event: "drain", listener: () => void): unknown;
  once(event: "drain", listener: () => void): unknown;
}>;

export function waitForDesktopRelayDrain(stream: DrainEmitter, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("Desktop relay output cancelled"));
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onAbort = () => { cleanup(); reject(new Error("Desktop relay output cancelled")); };
    stream.once("drain", onDrain);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function closeDesktopRelaySocket(socket: Pick<WebSocket, "close"> | RelayInputSocket, code?: number, reason?: string): void {
  try { socket.close(code, reason); } catch { /* the primary relay outcome remains authoritative */ }
}

export function waitForDesktopRelayOpen(socket: Pick<WebSocket, "addEventListener" | "removeEventListener" | "close">, timeoutMs = 15_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onError = () => {
      cleanup();
      reject(new Error("Desktop relay connection failed"));
      closeDesktopRelaySocket(socket);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Desktop relay connection timed out"));
      closeDesktopRelaySocket(socket);
    }, timeoutMs);
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

type OutputWriter = Readonly<{ write(data: Uint8Array, callback: (error?: Error | null) => void): unknown }>;

export async function writeDesktopRelayOutput(stream: OutputWriter, data: Uint8Array, signal: AbortSignal, timeoutMs = 30_000): Promise<void> {
  if (signal.aborted) throw new Error("Desktop relay output cancelled");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (message?: string) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (message) reject(new Error(message));
      else resolve();
    };
    const finish = (error?: Error | null) => settle(error ? "Desktop relay output failed" : undefined);
    const onAbort = () => settle("Desktop relay output cancelled");
    signal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => settle("Desktop relay output timed out"), timeoutMs);
    try { stream.write(data, finish); }
    catch { settle("Desktop relay output failed"); }
  });
}

type RelayInputReader = Readonly<{ read(): Promise<Readonly<{ done: boolean; value?: Uint8Array<ArrayBuffer> }>> }>;
type RelayInputSocket = Readonly<{
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array<ArrayBuffer>): unknown;
  close(code?: number, reason?: string): unknown;
}>;

export async function pumpDesktopRelayInput(reader: RelayInputReader, socket: RelayInputSocket): Promise<void> {
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        if (socket.readyState === WebSocket.OPEN) closeDesktopRelaySocket(socket, 1000, "SSH client closed");
        return;
      }
      if (next.value === undefined) throw new Error("Desktop relay input returned an invalid chunk");
      if (socket.readyState !== WebSocket.OPEN) return;
      for (let offset = 0; offset < next.value.byteLength; offset += 64 * 1024) {
        const frame = next.value.subarray(offset, Math.min(offset + 64 * 1024, next.value.byteLength));
        while (socket.bufferedAmount + frame.byteLength > 512 * 1024 && socket.readyState === WebSocket.OPEN) await Bun.sleep(5);
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(frame);
      }
    }
  } catch {
    if (socket.readyState === WebSocket.OPEN) closeDesktopRelaySocket(socket, 1011, "Desktop relay input failed");
    throw new Error("Desktop relay input failed");
  }
}

export async function finishDesktopRelayOutput(output: Promise<void>, controller: AbortController, timeoutMs = 30_000): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      output,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Desktop relay output timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type RelaySessionReader = RelayInputReader & Readonly<{ cancel(): Promise<unknown> }>;

async function finishDesktopRelayInput(input: Promise<void>, reader: RelaySessionReader, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cancellation = Promise.resolve().then(() => reader.cancel());
  try {
    await Promise.race([
      Promise.all([cancellation, input]),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Desktop relay input shutdown timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function runDesktopRelaySession(
  socket: WebSocket,
  relayToken: string,
  reader: RelaySessionReader,
  outputWriter: OutputWriter,
  outputTimeoutMs = 30_000,
): Promise<void> {
  socket.binaryType = "arraybuffer";
  const outputAbort = new AbortController();
  let output = Promise.resolve();
  let outputFailed = false;
  let pendingOutputBytes = 0;
  let reportOutputFailure!: (error: unknown) => void;
  const outputFailure = new Promise<{ kind: "output-failure"; error: unknown }>((resolve) => {
    reportOutputFailure = (error) => resolve({ kind: "output-failure", error });
  });
  let closed!: (value: { code: number; reason: string }) => void;
  const didClose = new Promise<{ code: number; reason: string }>((resolveClose) => { closed = resolveClose; });
  const onSocketMessage = (event: MessageEvent) => {
    if (!(event.data instanceof ArrayBuffer)) {
      reportOutputFailure(new Error("Desktop relay received an invalid frame"));
      closeDesktopRelaySocket(socket, 1008, "invalid relay frame");
      return;
    }
    const copy = new Uint8Array(event.data.slice(0));
    if (pendingOutputBytes + copy.byteLength > 512 * 1024) {
      reportOutputFailure(new Error("Desktop relay output limit exceeded"));
      closeDesktopRelaySocket(socket, 1011, "Desktop relay output limit exceeded");
      return;
    }
    pendingOutputBytes += copy.byteLength;
    output = output.then(() => writeDesktopRelayOutput(outputWriter, copy, outputAbort.signal, outputTimeoutMs)).catch((error) => {
      if (!outputFailed) {
        outputFailed = true;
      }
      reportOutputFailure(error);
      closeDesktopRelaySocket(socket, 1011, "Desktop relay output failed");
      throw error;
    }).finally(() => { pendingOutputBytes -= copy.byteLength; });
    void output.catch(() => undefined);
  };
  const onSocketClose = (event: CloseEvent) => {
    closed({ code: event.code, reason: event.reason });
  };
  const onSocketError = () => {
    reportOutputFailure(new Error("Desktop relay transport failed"));
    closeDesktopRelaySocket(socket, 1011, "Desktop relay transport failed");
  };
  socket.addEventListener("message", onSocketMessage);
  socket.addEventListener("close", onSocketClose, { once: true });
  socket.addEventListener("error", onSocketError, { once: true });
  try {
  await waitForDesktopRelayOpen(socket);
  try { socket.send(JSON.stringify({ type: "authenticate", relayToken })); }
  catch {
    closeDesktopRelaySocket(socket, 1011, "Desktop relay authentication failed");
    throw new Error("Desktop relay authentication failed");
  }
  const pump = pumpDesktopRelayInput(reader, socket);
  const pumpResult = pump.then(
    () => ({ kind: "input-complete" as const }),
    (error: unknown) => ({ kind: "input-failure" as const, error }),
  );
  const initial = await Promise.race([
    didClose.then((result) => ({ kind: "close" as const, result })),
    pumpResult,
    outputFailure,
  ]);
  let terminal:
    | { kind: "close"; result: { code: number; reason: string } }
    | { kind: "input-failure"; error: unknown }
    | { kind: "output-failure"; error: unknown }
    | { kind: "close-timeout" };
  if (initial.kind === "input-complete") {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      terminal = await Promise.race([
        didClose.then((result) => ({ kind: "close" as const, result })),
        outputFailure,
        new Promise<{ kind: "close-timeout" }>((resolve) => {
          timeout = setTimeout(() => resolve({ kind: "close-timeout" }), outputTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  } else terminal = initial;
  if (terminal.kind === "input-failure" || terminal.kind === "output-failure" || terminal.kind === "close-timeout") {
    outputAbort.abort();
    await Promise.allSettled([output, finishDesktopRelayInput(pump, reader, outputTimeoutMs)]);
    if (terminal.kind === "close-timeout") throw new Error("Desktop relay close timed out");
    throw terminal.error;
  }
  const result = terminal.result;
  const normalClose = result.code === 1000;
  if (!normalClose) outputAbort.abort();
  const [outputResult, inputResult] = await Promise.allSettled([
    normalClose ? finishDesktopRelayOutput(output, outputAbort, outputTimeoutMs) : output,
    finishDesktopRelayInput(pump, reader, outputTimeoutMs),
  ]);
  if (inputResult.status === "rejected") throw inputResult.reason;
  if (outputResult.status === "rejected") throw outputResult.reason;
  if (!normalClose) throw new Error(`Desktop relay closed (${result.code})`);
  } finally {
    socket.removeEventListener("message", onSocketMessage);
    socket.removeEventListener("close", onSocketClose);
    socket.removeEventListener("error", onSocketError);
  }
}

async function relayDesktop(realmId: string): Promise<void> {
  const paths = statePaths();
  await privateDirectory(paths.root);
  await privateDirectory(paths.profiles);
  await recoverRotation(paths, fetch);
  const profile = await loadProfile(realmId);
  const socket = new WebSocket(profile.relayUrl);
  const reader = Bun.stdin.stream().getReader();
  await runDesktopRelaySession(socket, profile.relayToken, reader, process.stdout);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 2 && args[0] === "relay" && args[1]) {
    await relayDesktop(args[1]);
    return;
  }
  if (args.length === 4 && args[0] === "pair" && args[1] && args[2] === "--package-spec" && args[3]) {
    await pairDesktop(args[1], { packageSpec: args[3] });
    return;
  }
  throw new TypeError("Usage: connect-desktop pair <pairing-url> --package-spec <immutable-sdk-package> | connect-desktop relay <realm-id>");
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : "Connect Desktop failed");
    process.exitCode = 1;
  }
}
