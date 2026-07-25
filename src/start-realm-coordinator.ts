import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { gatewayMountRevision, gatewayProcessSessionName, loadGatewayManifest, parseActiveGatewayMount, readGatewayAsset, type ActiveGatewayMount } from "./gateway-runtime";
import {
  desktopSshRelayPort,
  effectiveSshdUsesAuthorizedKeysFile,
  formatRegistrationUrlBlock,
  parseActiveRealmRecord,
  parseActiveSshRelayRecord,
  parseManagedTunnelRecord,
  parseStartRealmArgs,
  parseStartRealmConfig,
  parseGatewayPackageLocator,
  probeHealthInFreshBun,
  probePublicHealth,
  renderLoopbackSshdDropIn,
  startRealmSessionNames,
  waitForManagedPublicHealth,
  type ManagedTunnelRecord,
} from "./start-realm-core";

const rawArgs = process.argv.slice(2);
const invocation = parseStartRealmArgs(rawArgs);
const configPath = resolve(invocation.configPath);
const config = parseStartRealmConfig(JSON.parse(await readFile(configPath, "utf8")));
const stateDir = resolve(dirname(configPath), config.stateDir);
const activeRealmPath = resolve(stateDir, "active-realm.json");
const managedTunnelPath = resolve(stateDir, "managed-tunnel.json");
const activeSshRelayPath = resolve(stateDir, "active-ssh-relay.json");
const activeGatewaysPath = resolve(stateDir, "active-gateways.json");
const managedSshTunnelPath = resolve(stateDir, "managed-ssh-tunnel.json");
const sshRelayPort = desktopSshRelayPort(config.port);
const workerPath = resolve(import.meta.dir, "start-realm.ts");
const sessions = startRealmSessionNames(config.realm.id, stateDir);
let sshConfigurationChanged = false;

async function currentRuntimeRevision(): Promise<string> {
  const hash = createHash("sha256");
  try {
    hash.update(await readFile(resolve(import.meta.dir, "../.realm-sdk-publication.json")));
    hash.update(await readFile(resolve(import.meta.dir, "../app-v2/current.json")));
  } catch {
    hash.update(await readFile(import.meta.path));
    hash.update(await readFile(workerPath));
  }
  return hash.digest("hex");
}

const runtimeRevision = await currentRuntimeRevision();

await mkdir(stateDir, { recursive: true, mode: 0o700 });
await chmod(stateDir, 0o700);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function run(command: readonly string[], env?: Readonly<Record<string, string>>): Promise<Readonly<{ code: number; stdout: string; stderr: string }>> {
  const child = Bun.spawn([...command], {
    env: env ? { ...process.env, ...env } : process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return Object.freeze({ code, stdout, stderr });
}

async function ensureLoopbackSshGateway(): Promise<void> {
  const ssh = config.desktop?.ssh;
  if (!ssh || ssh.host !== "127.0.0.1" || ssh.port !== 22 || process.platform !== "linux") return;
  const authorizedKeysFile = resolve(stateDir, "desktop-authorized-keys");
  const context = `user=${ssh.user},host=${config.realm.id}.klivcore.invalid,addr=127.0.0.1,laddr=127.0.0.1,lport=22`;
  const effective = await run(["sudo", "-n", "sshd", "-T", "-C", context]);
  if (effective.code === 0 && effectiveSshdUsesAuthorizedKeysFile(effective.stdout, authorizedKeysFile)) {
    console.log("Reusing SSH Gateway host integration");
    return;
  }
  const target = "/etc/ssh/sshd_config.d/99-klivcore-realm-gateway.conf";
  const exists = await run(["sudo", "-n", "test", "-e", target]);
  if (exists.code === 0) throw new Error(`SSH Gateway host integration exists but is ineffective: ${target}`);
  const stage = resolve(stateDir, ".sshd-realm-gateway.conf");
  await writeFile(stage, renderLoopbackSshdDropIn(ssh.user, authorizedKeysFile), { mode: 0o600 });
  try {
    const install = await run(["sudo", "-n", "install", "-m", "0644", stage, target]);
    if (install.code !== 0) throw new Error(install.stderr.trim() || "passwordless sudo is required to configure the SSH Gateway");
    const validate = await run(["sudo", "-n", "sshd", "-t"]);
    if (validate.code !== 0) {
      await run(["sudo", "-n", "rm", "-f", target]);
      throw new Error(validate.stderr.trim() || "sshd rejected the SSH Gateway configuration");
    }
    const reload = await run(["sudo", "-n", "systemctl", "reload", "sshd"]);
    if (reload.code !== 0) {
      await run(["sudo", "-n", "rm", "-f", target]);
      throw new Error(reload.stderr.trim() || "failed to reload sshd after SSH Gateway setup");
    }
    const verified = await run(["sudo", "-n", "sshd", "-T", "-C", context]);
    if (verified.code !== 0 || !effectiveSshdUsesAuthorizedKeysFile(verified.stdout, authorizedKeysFile)) {
      await run(["sudo", "-n", "rm", "-f", target]);
      await run(["sudo", "-n", "systemctl", "reload", "sshd"]);
      throw new Error("sshd did not activate the Realm Desktop authorized-keys projection");
    }
    console.log("Configured and verified SSH Gateway host integration");
  } finally {
    await rm(stage, { force: true });
  }
}

async function tmux(args: readonly string[]): Promise<Readonly<{ code: number; stdout: string; stderr: string }>> {
  return run(["tmux", ...args]);
}

async function tmuxExists(sessionName: string): Promise<boolean> {
  const result = await tmux(["has-session", "-t", `=${sessionName}`]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(result.stderr.trim() || `tmux has-session failed (${result.code})`);
}

function managedLogPath(sessionName: string): string {
  const name = sessionName === sessions.tunnel ? "managed-tunnel.log"
    : sessionName === sessions.sshTunnel ? "managed-ssh-tunnel.log"
      : sessionName === sessions.sshRelay ? "ssh-relay.log" : "realm.log";
  return resolve(stateDir, name);
}

async function tmuxOutput(sessionName: string): Promise<string> {
  const result = await tmux(["capture-pane", "-p", "-t", `${sessionName}:0.0`, "-S", "-80"]);
  if (result.code === 0) return result.stdout.trim();
  const logPath = managedLogPath(sessionName);
  return readFile(logPath, "utf8").then((value) => value.trim()).catch(() => result.stderr.trim());
}

async function readActiveGateways(): Promise<readonly ActiveGatewayMount[]> {
  let info;
  try { info = await lstat(activeGatewaysPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]); throw error; }
  const uid = process.getuid?.();
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 1024 * 1024
    || (info.mode & 0o777) !== 0o600 || (uid !== undefined && info.uid !== uid)) throw new Error("unsafe active Gateway registry");
  const value = JSON.parse(await readFile(activeGatewaysPath, "utf8"));
  if (!Array.isArray(value) || value.length > 32) throw new Error("active Gateway registry is invalid");
  return Object.freeze(value.map(parseActiveGatewayMount));
}

async function privateWrite(path: string, content: string): Promise<void> {
  const stage = `${path}.stage-${crypto.randomUUID()}`;
  try {
    await writeFile(stage, content, { flag: "wx", mode: 0o600 });
    await rename(stage, path);
    await chmod(path, 0o600);
  } finally { await rm(stage, { force: true }); }
}

async function validateGatewayTree(root: string): Promise<void> {
  let files = 0;
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Gateway package contains a symlink: ${relative(root, path)}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const info = await lstat(path);
        files += 1; bytes += info.size;
        if (files > 512 || bytes > 64 * 1024 * 1024) throw new Error("Gateway package exceeds safety limits");
      } else throw new Error("Gateway package contains an unsupported filesystem entry");
    }
  };
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Gateway package root is invalid");
  await visit(root);
}

async function materializeGatewayPackage(key: string, source: string, revision: string): Promise<string> {
  const locator = parseGatewayPackageLocator(source);
  const target = resolve(stateDir, "gateway-packages", key, revision);
  try {
    await validateGatewayTree(target);
    await loadGatewayManifest(target);
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") await rm(target, { recursive: true, force: true });
  }
  const parent = dirname(target);
  const workspace = resolve(stateDir, `.gateway-fetch-${crypto.randomUUID()}`);
  const checkout = resolve(workspace, "checkout");
  const stage = resolve(parent, `.stage-${crypto.randomUUID()}`);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  try {
    for (const command of [
      ["git", "init", "--quiet", checkout],
      ["git", "-C", checkout, "remote", "add", "origin", locator.repository],
      ["git", "-C", checkout, "fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", locator.commit],
      ["git", "-C", checkout, "checkout", "--quiet", "--detach", "FETCH_HEAD"],
    ] as const) {
      const result = await run(command);
      if (result.code !== 0) throw new Error(result.stderr.trim() || `Gateway source resolution failed: ${command[1]}`);
    }
    const resolved = await run(["git", "-C", checkout, "rev-parse", "HEAD"]);
    if (resolved.code !== 0 || resolved.stdout.trim() !== locator.commit) throw new Error("Gateway source did not resolve to its pinned commit");
    const sourceRoot = resolve(checkout, locator.packagePath);
    if (!sourceRoot.startsWith(`${checkout}/`)) throw new Error("Gateway package path escaped checkout");
    await validateGatewayTree(sourceRoot);
    await cp(sourceRoot, stage, { recursive: true, errorOnExist: true, dereference: false });
    await validateGatewayTree(stage);
    await loadGatewayManifest(stage);
    await rename(stage, target);
    return target;
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(stage, { recursive: true, force: true });
  }
}

async function allocateGatewayPort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("failed to allocate a Gateway loopback port");
  return port;
}

async function gatewayHealthy(mount: ActiveGatewayMount): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${mount.port}${mount.manifest.httpRelay.healthPath}`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const body = await response.json() as { status?: unknown };
    return body.status === "ok";
  } catch { return false; }
}

async function waitForGateway(mount: ActiveGatewayMount): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!await tmuxExists(mount.sessions.server!)) throw new Error(`Gateway server exited during startup: ${mount.key}`);
    if (await gatewayHealthy(mount)) return;
    await Bun.sleep(250);
  }
  throw new Error(`Gateway did not become healthy: ${mount.key}`);
}

async function stopGatewaySessions(mount: ActiveGatewayMount): Promise<void> {
  for (const session of Object.values(mount.sessions)) {
    if (!await tmuxExists(session)) continue;
    const stopped = await tmux(["kill-session", "-t", `=${session}`]);
    if (stopped.code !== 0) throw new Error(stopped.stderr.trim() || `failed to stop Gateway session ${session}`);
  }
}

async function startGatewayProcess(mount: ActiveGatewayMount, role: string, entrypoint: string): Promise<void> {
  const session = mount.sessions[role];
  if (!session) throw new Error(`Gateway process session is missing: ${mount.key}/${role}`);
  await readGatewayAsset(mount.packageRoot, entrypoint, 16 * 1024 * 1024);
  const logs = resolve(mount.home, "logs");
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const logPath = resolve(logs, `${role}.log`);
  await writeFile(logPath, "", { mode: 0o600 });
  const env = {
    KLIVCORE_GATEWAY_MOUNT: mount.key,
    KLIVCORE_GATEWAY_HOME: mount.home,
    KLIVCORE_GATEWAY_CONFIG: mount.configPath,
    KLIVCORE_GATEWAY_PORT: String(mount.port),
  };
  const assignments = Object.entries(env).map(([name, value]) => `${name}=${shellQuote(value)}`).join(" ");
  const command = `${assignments} exec ${shellQuote(process.execPath)} ${shellQuote(resolve(mount.packageRoot, entrypoint))} >>${shellQuote(logPath)} 2>&1`;
  const started = await tmux(["new-session", "-d", "-s", session, "-c", mount.packageRoot, command]);
  if (started.code !== 0) throw new Error(started.stderr.trim() || `failed to start Gateway process ${mount.key}/${role}`);
}

async function ensureGateways(): Promise<boolean> {
  const previous = await readActiveGateways();
  const configured = Object.entries(config.gateways ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const configuredKeys = new Set(configured.map(([key]) => key));
  let changed = false;
  for (const stale of previous.filter((mount) => !configuredKeys.has(mount.key))) {
    console.log(`Stopping disabled Gateway: ${stale.key}`);
    await stopGatewaySessions(stale);
    changed = true;
  }
  const active: ActiveGatewayMount[] = [];
  for (const [key, mountConfig] of configured) {
    const revision = gatewayMountRevision(key, mountConfig);
    const packageRoot = await materializeGatewayPackage(key, mountConfig.source, revision);
    const manifest = await loadGatewayManifest(packageRoot);
    const home = resolve(stateDir, "gateways", mountConfig.storageSubdir);
    const configPath = resolve(home, "config.json");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    await privateWrite(configPath, `${JSON.stringify(mountConfig.config, null, 2)}\n`);
    const prior = previous.find((candidate) => candidate.key === key);
    const sessions = Object.freeze(Object.fromEntries(manifest.processes.map((process) => [
      process.role,
      gatewayProcessSessionName(config.realm.id, stateDir, key, process.role),
    ])));
    const candidate = Object.freeze({
      schemaVersion: 1 as const,
      key,
      source: mountConfig.source,
      revision,
      baseRoute: mountConfig.baseRoute,
      storageSubdir: mountConfig.storageSubdir,
      packageRoot,
      home,
      configPath,
      port: prior?.port ?? await allocateGatewayPort(),
      sessions,
      manifest,
    });
    const reusable = prior?.revision === candidate.revision && prior.source === candidate.source
      && prior.baseRoute === candidate.baseRoute && prior.storageSubdir === candidate.storageSubdir
      && JSON.stringify(prior.sessions) === JSON.stringify(candidate.sessions)
      && (await Promise.all(Object.values(candidate.sessions).map(tmuxExists))).every(Boolean)
      && await gatewayHealthy(candidate);
    if (reusable) {
      console.log(`Reusing Gateway: ${key} (${revision.slice(0, 12)})`);
      active.push(candidate);
      continue;
    }
    if (prior) await stopGatewaySessions(prior);
    for (const session of Object.values(candidate.sessions)) {
      if (await tmuxExists(session)) await tmux(["kill-session", "-t", `=${session}`]);
    }
    console.log(`${prior ? "Updating" : "Starting"} Gateway: ${key} (${revision.slice(0, 12)})`);
    const server = manifest.processes.find((process) => process.role === "server")!;
    await startGatewayProcess(candidate, server.role, server.entrypoint);
    await waitForGateway(candidate);
    for (const process of manifest.processes) if (process.role !== "server") await startGatewayProcess(candidate, process.role, process.entrypoint);
    active.push(candidate);
    changed = true;
  }
  if (active.length === 0) await rm(activeGatewaysPath, { force: true });
  else await privateWrite(activeGatewaysPath, `${JSON.stringify(active, null, 2)}\n`);
  if (JSON.stringify(previous.map((mount) => ({ key: mount.key, revision: mount.revision, baseRoute: mount.baseRoute, port: mount.port })))
    !== JSON.stringify(active.map((mount) => ({ key: mount.key, revision: mount.revision, baseRoute: mount.baseRoute, port: mount.port })))) changed = true;
  return changed;
}

async function startTmuxWorker(sessionName: string, environment: Readonly<Record<string, string>>): Promise<void> {
  const logPath = managedLogPath(sessionName);
  await writeFile(logPath, "", { mode: 0o600 });
  await chmod(logPath, 0o600);
  const assignments = Object.entries(environment).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
  const workerCommand = `${assignments} exec ${shellQuote(process.execPath)} ${shellQuote(workerPath)} ${shellQuote(configPath)} >>${shellQuote(logPath)} 2>&1`;
  const result = await tmux(["new-session", "-d", "-s", sessionName, "-c", dirname(configPath), workerCommand]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `failed to create tmux session ${sessionName}`);
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function assertPrivateRecord(path: string): Promise<void> {
  const info = await lstat(path);
  const getuid = process.getuid?.();
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600
    || info.size < 2 || info.size > 4_096 || (getuid !== undefined && info.uid !== getuid)) {
    throw new Error(`unsafe runtime record: ${path}`);
  }
}

type ManagedTunnelOptions = Readonly<{
  path: string;
  port: number;
  sessionName: string;
  workerMode: "tunnel" | "ssh-tunnel";
  label: string;
}>;

async function readManagedTunnel(options: ManagedTunnelOptions): Promise<ManagedTunnelRecord> {
  await assertPrivateRecord(options.path);
  const record = parseManagedTunnelRecord(
    JSON.parse(await readFile(options.path, "utf8")),
    config.realm.id,
    options.port,
    options.sessionName,
  );
  if (!processIsAlive(record.pid)) throw new Error("managed tunnel worker is not running");
  return record;
}

async function waitForManagedTunnel(options: ManagedTunnelOptions): Promise<ManagedTunnelRecord> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (!await tmuxExists(options.sessionName)) {
      throw new Error(`${options.label} session exited during startup\n${await tmuxOutput(options.sessionName)}`);
    }
    try { return await readManagedTunnel(options); } catch { await Bun.sleep(500); }
  }
  throw new Error(`${options.label} did not publish its origin\n${await tmuxOutput(options.sessionName)}`);
}

async function ensureManagedTunnel(options: ManagedTunnelOptions): Promise<ManagedTunnelRecord> {
  if (await tmuxExists(options.sessionName)) {
    console.log(`Reusing ${options.label} session: ${options.sessionName}`);
    return waitForManagedTunnel(options);
  }
  await rm(options.path, { force: true });
  console.log(`Starting ${options.label} session: ${options.sessionName}`);
  await startTmuxWorker(options.sessionName, {
    KLIVCORE_START_REALM_MODE: options.workerMode,
    KLIVCORE_START_REALM_TUNNEL_SESSION: options.sessionName,
  });
  return waitForManagedTunnel(options);
}

async function readActiveSshRelay(
  expectedConfigRevision: string,
  expectedRealmPublicOrigin: string,
): Promise<ReturnType<typeof parseActiveSshRelayRecord>> {
  await assertPrivateRecord(activeSshRelayPath);
  const record = parseActiveSshRelayRecord(
    JSON.parse(await readFile(activeSshRelayPath, "utf8")),
    config.realm.id,
    sshRelayPort,
    sessions.sshRelay,
    expectedConfigRevision,
    expectedRealmPublicOrigin,
  );
  if (!processIsAlive(record.pid)) throw new Error("SSH Core relay worker is not running");
  return record;
}

async function waitForSshRelay(
  expectedConfigRevision: string,
  expectedRealmPublicOrigin: string,
): Promise<ReturnType<typeof parseActiveSshRelayRecord>> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!await tmuxExists(sessions.sshRelay)) {
      throw new Error(`SSH Core relay session exited during startup\n${await tmuxOutput(sessions.sshRelay)}`);
    }
    try {
      const record = await readActiveSshRelay(expectedConfigRevision, expectedRealmPublicOrigin);
      await probeHealthInFreshBun(record.localOrigin, config.realm.id);
      return record;
    } catch { await Bun.sleep(500); }
  }
  throw new Error(`SSH Core relay did not become ready\n${await tmuxOutput(sessions.sshRelay)}`);
}

async function ensureSshRelay(realmPublicOrigin: string): Promise<ReturnType<typeof parseActiveSshRelayRecord>> {
  const configRevision = createHash("sha256").update(JSON.stringify({
    realmPublicOrigin,
    ssh: config.desktop!.ssh,
  })).digest("hex");
  if (await tmuxExists(sessions.sshRelay)) {
    try {
      const record = await readActiveSshRelay(configRevision, realmPublicOrigin);
      await probeHealthInFreshBun(record.localOrigin, config.realm.id);
      console.log(`Reusing SSH Core relay session: ${sessions.sshRelay}`);
      return record;
    } catch {
      sshConfigurationChanged = true;
      console.log(`Replacing SSH Core relay session after SSH configuration changed: ${sessions.sshRelay}`);
      const stopped = await tmux(["kill-session", "-t", `=${sessions.sshRelay}`]);
      if (stopped.code !== 0) throw new Error(stopped.stderr.trim() || "failed to stop outdated SSH Core relay session");
    }
  }
  sshConfigurationChanged = true;
  await rm(activeSshRelayPath, { force: true });
  console.log(`Starting SSH Core relay session: ${sessions.sshRelay}`);
  await startTmuxWorker(sessions.sshRelay, {
    KLIVCORE_START_REALM_MODE: "ssh-relay",
    KLIVCORE_START_REALM_PUBLIC_ORIGIN: realmPublicOrigin,
    KLIVCORE_START_REALM_SSH_RELAY_SESSION: sessions.sshRelay,
    KLIVCORE_START_REALM_SSH_CONFIG_REVISION: configRevision,
  });
  return waitForSshRelay(configRevision, realmPublicOrigin);
}

async function disableManagedSsh(): Promise<void> {
  for (const [sessionName, label] of [
    [sessions.sshTunnel, "SSH Quick Tunnel"],
    [sessions.sshRelay, "SSH Core relay"],
  ] as const) {
    if (!await tmuxExists(sessionName)) continue;
    console.log(`Stopping disabled ${label} session: ${sessionName}`);
    const stopped = await tmux(["kill-session", "-t", `=${sessionName}`]);
    if (stopped.code !== 0) throw new Error(stopped.stderr.trim() || `failed to stop disabled ${label}`);
  }
  await Promise.all([
    rm(managedSshTunnelPath, { force: true }),
    rm(activeSshRelayPath, { force: true }),
  ]);
}

async function readActiveRealm(
  expectedPublicOrigin: string,
  expectedSshPublicOrigin?: string | null,
): Promise<ReturnType<typeof parseActiveRealmRecord>> {
  await assertPrivateRecord(activeRealmPath);
  const record = parseActiveRealmRecord(
    JSON.parse(await readFile(activeRealmPath, "utf8")),
    config.realm.id,
    config.port,
    expectedPublicOrigin,
    expectedSshPublicOrigin,
  );
  if (!processIsAlive(record.pid)) throw new Error("Realm worker is not running");
  return record;
}

async function waitForRealm(expectedPublicOrigin: string, expectedSshPublicOrigin?: string | null): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  let nextReport = Date.now();
  while (Date.now() < deadline) {
    if (!await tmuxExists(sessions.realm)) {
      throw new Error(`Realm session exited during startup\n${await tmuxOutput(sessions.realm)}`);
    }
    try {
      const record = await readActiveRealm(expectedPublicOrigin, expectedSshPublicOrigin);
      await probeHealthInFreshBun(record.localOrigin, config.realm.id);
      await probePublicHealth(record.publicOrigin, config.realm.id);
      return;
    } catch {
      if (Date.now() >= nextReport) {
        console.log(`Waiting for Realm session ${sessions.realm}...`);
        const output = await tmuxOutput(sessions.realm);
        if (output) console.log(output);
        nextReport = Date.now() + 30_000;
      }
      await Bun.sleep(500);
    }
  }
  throw new Error(`Realm did not become ready\n${await tmuxOutput(sessions.realm)}`);
}

async function ensureRealm(
  publicOrigin: string,
  sshPublicOrigin: string | undefined,
  tunnelPid?: number,
  forceRestart = false,
): Promise<void> {
  if (await tmuxExists(sessions.realm)) {
    let active: Awaited<ReturnType<typeof readActiveRealm>> | undefined;
    try { active = await readActiveRealm(publicOrigin, sshPublicOrigin ?? null); } catch { /* incompatible workers are replaced below */ }
    if (!active || active.runtimeRevision !== runtimeRevision || forceRestart) {
      console.log(active
        ? `Updating Realm runtime: ${active.runtimeRevision?.slice(0, 12) ?? "legacy"} -> ${runtimeRevision.slice(0, 12)}`
        : "Replacing Realm session with changed runtime endpoint configuration");
      const stopped = await tmux(["kill-session", "-t", `=${sessions.realm}`]);
      if (stopped.code !== 0) throw new Error(stopped.stderr.trim() || "failed to stop outdated Realm session");
      await rm(activeRealmPath, { force: true });
    } else {
      console.log(`Reusing Realm session: ${sessions.realm} (${runtimeRevision.slice(0, 12)})`);
    }
  }
  if (!await tmuxExists(sessions.realm)) {
    try {
      const stale = parseActiveRealmRecord(JSON.parse(await readFile(activeRealmPath, "utf8")), config.realm.id, config.port);
      if (!processIsAlive(stale.pid)) await rm(activeRealmPath, { force: true });
    } catch { await rm(activeRealmPath, { force: true }); }
    console.log(`Starting Realm session: ${sessions.realm} (${runtimeRevision.slice(0, 12)})`);
    await startTmuxWorker(sessions.realm, {
      KLIVCORE_START_REALM_MODE: "realm",
      KLIVCORE_START_REALM_PUBLIC_ORIGIN: publicOrigin,
      ...(sshPublicOrigin ? { KLIVCORE_START_REALM_SSH_PUBLIC_ORIGIN: sshPublicOrigin } : {}),
      KLIVCORE_START_REALM_RUNTIME_REVISION: runtimeRevision,
      ...(tunnelPid ? { KLIVCORE_START_REALM_TUNNEL_PID: String(tunnelPid) } : {}),
    });
  }
  await waitForRealm(publicOrigin, sshPublicOrigin ?? null);
}

async function registrationUrl(): Promise<string> {
  const result = await run([process.execPath, workerPath, "registration-url", configPath]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `registration URL command failed (${result.code})`);
  const value = result.stdout.trim();
  if (!value) throw new Error("registration URL command returned no URL");
  return value;
}

if (invocation.command === "registration-url") {
  console.log(await registrationUrl());
  process.exit(0);
}

await ensureLoopbackSshGateway();

const tmuxVersion = await tmux(["-V"]);
if (tmuxVersion.code !== 0) throw new Error("start-realm requires tmux for durable managed sessions");

const tunnel = config.publicOrigin ? undefined : await ensureManagedTunnel({
  path: managedTunnelPath,
  port: config.port,
  sessionName: sessions.tunnel,
  workerMode: "tunnel",
  label: "managed Realm Quick Tunnel",
});
const publicOrigin = config.publicOrigin ?? tunnel!.publicOrigin;
let sshTunnel: ManagedTunnelRecord | undefined;
if (config.desktop) {
  await ensureSshRelay(publicOrigin);
  sshTunnel = await ensureManagedTunnel({
    path: managedSshTunnelPath,
    port: sshRelayPort,
    sessionName: sessions.sshTunnel,
    workerMode: "ssh-tunnel",
    label: "managed SSH Quick Tunnel",
  });
  await waitForManagedPublicHealth({
    probe: () => probePublicHealth(sshTunnel!.publicOrigin, config.realm.id),
    tunnelExitCode: () => processIsAlive(sshTunnel!.pid) ? null : -1,
    onWaiting: (message) => console.log(`Waiting for managed SSH Quick Tunnel public health: ${message}`),
  });
} else {
  await disableManagedSsh();
}
const gatewaysChanged = await ensureGateways();
await ensureRealm(publicOrigin, sshTunnel?.publicOrigin, tunnel?.pid, sshConfigurationChanged || gatewaysChanged);
const firstRegistrationUrl = await registrationUrl();

console.log("\nRealm ready");
console.log(`Realm URL: ${publicOrigin}`);
console.log(`SDK runtime: ${runtimeRevision.slice(0, 12)}`);
console.log(formatRegistrationUrlBlock(firstRegistrationUrl));
console.log("Next steps:");
console.log("  1. Open the registration URL now and create the first passkey.");
console.log("  2. Sign in to the Realm URL.");
if (config.desktop) console.log("  3. Choose Connect Desktop from the authenticated Realm menu.");
console.log("Durable sessions:");
if (tunnel) console.log(`  Tunnel: tmux attach-session -t ${sessions.tunnel}`);
console.log(`  Realm:  tmux attach-session -t ${sessions.realm}`);
if (sshTunnel) {
  console.log(`  SSH relay:  tmux attach-session -t ${sessions.sshRelay}`);
  console.log(`  SSH tunnel: tmux attach-session -t ${sessions.sshTunnel}`);
}
for (const mount of await readActiveGateways()) {
  for (const [role, session] of Object.entries(mount.sessions)) {
    console.log(`  Gateway ${mount.key}/${role}: tmux attach-session -t ${session}`);
  }
}
console.log("Restart only a broken component:");
console.log(`  Realm:  tmux kill-session -t ${sessions.realm}; rerun this start-realm command`);
if (tunnel) console.log(`  Tunnel: tmux kill-session -t ${sessions.tunnel}; tmux kill-session -t ${sessions.realm}; rerun this start-realm command`);
if (sshTunnel) console.log(`  SSH:    tmux kill-session -t ${sessions.sshTunnel}; tmux kill-session -t ${sessions.sshRelay}; rerun this start-realm command`);
