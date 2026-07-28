import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { gatewayDurableHome, gatewayImmutablePackageRoot, gatewayLegacyProcessSupervisorArgv, gatewayMountRevision, gatewayPackageDigest, gatewayProcessSessionName, gatewayProcessSupervisorArgv, gatewayProcessSupervisorArgvCompatible, gatewaySandboxRoot, gatewayServiceUser, loadGatewayManifest, parseActiveGatewayMount, recoverGatewayPackageRootFromWorkerArgv, recoverGatewayPortFromWorkerEnvironment, replaceActiveGatewayMount, readGatewayAsset, type ActiveGatewayMount } from "./gateway-runtime";
import {
  desktopSshRelayPort,
  effectiveSshdUsesAuthorizedKeysFile,
  failAfterRollbackOperations,
  formatRegistrationUrlBlock,
  isCompatibleManagedWorkerForReuse,
  isExactManagedProcess,
  isManagedLoopbackSshdDropIn,
  isStaleManagedRealmWorker,
  managedSshdDropInStatIsSafe,
  isOwnedRealmWorkerCommand,
  parseActiveRealmRecord,
  parseActiveSshRelayRecord,
  parseManagedTunnelRecord,
  priorRealmDirectorySessionMode,
  parseStartRealmArgs,
  parseStartRealmConfig,
  parseGatewayPackageLocator,
  probeHealthInFreshBun,
  probePublicHealth,
  renderLoopbackSshdDropIn,
  startRealmSessionNames,
  terminateExactManagedProcess,
  tmuxStopResultIsSafe,
  waitForManagedPublicHealth,
  type ManagedProcessExpectation,
  type ManagedProcessSnapshot,
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
  if (exists.code === 0) {
    const metadata = await run(["sudo", "-n", "stat", "-c", "%f\n%u\n%s", "--", target]);
    const content = await run(["sudo", "-n", "cat", "--", target]);
    if (metadata.code !== 0 || content.code !== 0
      || !managedSshdDropInStatIsSafe(metadata.stdout)
      || !isManagedLoopbackSshdDropIn(content.stdout, ssh.user)) {
      throw new Error(`SSH Gateway host integration exists but is not a recognized managed file: ${target}`);
    }
    console.log("Replacing stale SSH Gateway host integration");
  }
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

async function tmuxSessionNames(): Promise<readonly string[]> {
  const result = await tmux(["list-sessions", "-F", "#{session_name}"]);
  if (result.code === 1 && /no server running|no sessions/u.test(result.stderr)) return Object.freeze([]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "failed to list tmux sessions");
  const names = result.stdout.trim() ? result.stdout.trim().split("\n") : [];
  if (names.length > 128 || names.some((name) => !/^[A-Za-z0-9_.-]{1,128}$/u.test(name))) {
    throw new Error("tmux session list is invalid");
  }
  return Object.freeze(names);
}

async function tmuxPanePid(sessionName: string): Promise<number> {
  const result = await tmux(["display-message", "-p", "-t", `=${sessionName}:0.0`, "#{pane_pid}"]);
  const value = result.stdout.trim();
  if (result.code !== 0 || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(result.stderr.trim() || `managed tmux session has no exact pane PID: ${sessionName}`);
  }
  const pid = Number(value);
  if (!Number.isSafeInteger(pid)) throw new Error(`managed tmux session pane PID is invalid: ${sessionName}`);
  return pid;
}

async function readManagedProcessSnapshot(pid: number): Promise<ManagedProcessSnapshot | undefined> {
  const script = [
    "import json, sys",
    "pid = int(sys.argv[1]); root = f'/proc/{pid}'",
    "try:",
    "  argv = [part.decode('utf-8', 'strict') for part in open(root + '/cmdline', 'rb').read().split(b'\\0') if part]",
    "  status = open(root + '/status', encoding='utf-8').read().splitlines()",
    "  stat = open(root + '/stat', encoding='utf-8').read()",
    "except (FileNotFoundError, ProcessLookupError): sys.exit(3)",
    "uid = int(next(line for line in status if line.startswith('Uid:')).split()[1])",
    "gid = int(next(line for line in status if line.startswith('Gid:')).split()[1])",
    "tail = stat[stat.rfind(')') + 2:].split(); start = tail[19]",
    "print(json.dumps({'pid': pid, 'startTimeTicks': start, 'uid': uid, 'gid': gid, 'argv': argv}, separators=(',', ':')))",
  ].join("\n");
  const result = await run(["python3", "-c", script, String(pid)]);
  if (result.code === 3) return undefined;
  if (result.code !== 0) throw new Error(result.stderr.trim() || `failed to inspect managed process ${pid}`);
  const value = JSON.parse(result.stdout) as ManagedProcessSnapshot;
  if (!value || typeof value !== "object" || value.pid !== pid || !Array.isArray(value.argv)
    || typeof value.startTimeTicks !== "string" || !Number.isSafeInteger(value.uid) || !Number.isSafeInteger(value.gid)) {
    throw new Error(`managed process snapshot is invalid: ${pid}`);
  }
  return Object.freeze({ ...value, argv: Object.freeze([...value.argv]) });
}

async function readManagedProcessEnvironment(pid: number): Promise<Readonly<Record<string, string>>> {
  let data: Buffer;
  try { data = await readFile(`/proc/${pid}/environ`); }
  catch (error) { if (!await readManagedProcessSnapshot(pid)) return Object.freeze({}); throw error; }
  if (data.byteLength > 1024 * 1024) throw new Error(`managed process environment exceeds safety limits: ${pid}`);
  const selected: Record<string, string> = {};
  for (const entry of data.toString("utf8").split("\0")) {
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    const key = entry.slice(0, separator);
    if (["KLIVCORE_START_REALM_MODE", "KLIVCORE_START_REALM_SSH_RELAY_SESSION", "KLIVCORE_START_REALM_TUNNEL_SESSION"].includes(key)) {
      selected[key] = entry.slice(separator + 1);
    }
  }
  return Object.freeze(selected);
}

async function inspectOwnedTmuxSession(sessionName: string, expected: ManagedProcessExpectation): Promise<ManagedProcessSnapshot> {
  const pid = await tmuxPanePid(sessionName);
  const snapshot = await readManagedProcessSnapshot(pid);
  if (!snapshot || !isExactManagedProcess(snapshot, { ...expected, pid: expected.pid ?? pid })) {
    throw new Error(`refusing to manage tmux session with unverified process identity: ${sessionName}`);
  }
  return snapshot;
}

async function inspectReusableTmuxWorker(sessionName: string, expected: ManagedProcessExpectation): Promise<ManagedProcessSnapshot> {
  const pid = await tmuxPanePid(sessionName);
  const snapshot = await readManagedProcessSnapshot(pid);
  if (!snapshot || !isCompatibleManagedWorkerForReuse(snapshot, { ...expected, pid: expected.pid ?? pid })) {
    throw new Error(`refusing to reuse tmux session with unverified process identity: ${sessionName}`);
  }
  return snapshot;
}

async function inspectCompatibleGatewayPane(
  sessionName: string,
  expected: ManagedProcessExpectation,
  serviceUid: number,
  serviceGid: number,
): Promise<ManagedProcessSnapshot> {
  const pid = await tmuxPanePid(sessionName);
  const snapshot = await readManagedProcessSnapshot(pid);
  if (!snapshot
    || !isExactManagedProcess(snapshot, { ...expected, pid: expected.pid ?? pid, argv: snapshot.argv })
    || !gatewayProcessSupervisorArgvCompatible(snapshot.argv, expected.argv, serviceUid, serviceGid)) {
    throw new Error(`refusing to reuse tmux session with unverified process identity: ${sessionName}`);
  }
  return snapshot;
}

async function stopRevalidatedProcess(initial: ManagedProcessSnapshot, expected: ManagedProcessExpectation, label: string): Promise<void> {
  await terminateExactManagedProcess(initial, expected, {
    read: readManagedProcessSnapshot,
    signal: async (pid, signal) => {
      const result = await run(["sudo", "-n", "kill", `-${signal}`, "--", String(pid)]);
      if (result.code !== 0 && await readManagedProcessSnapshot(pid)) {
        throw new Error(result.stderr.trim() || `failed to send SIG${signal} to ${label}`);
      }
    },
    sleep: Bun.sleep,
    now: Date.now,
  });
}

async function removeDeadTmuxSession(sessionName: string, label: string): Promise<void> {
  if (await tmuxExists(sessionName)) {
    const dead = await tmux(["display-message", "-p", "-t", `=${sessionName}:0.0`, "#{pane_dead}"]);
    if (dead.code !== 0 || dead.stdout.trim() !== "1") throw new Error(`refusing to remove a live tmux session after stopping ${label}`);
    const stopped = await tmux(["kill-session", "-t", `=${sessionName}`]);
    if (!tmuxStopResultIsSafe(stopped.code, await tmuxExists(sessionName))) {
      throw new Error(stopped.stderr.trim() || `failed to remove stopped tmux session for ${label}`);
    }
  }
}

async function stopOwnedTmuxSession(sessionName: string, expected: ManagedProcessExpectation, label: string): Promise<void> {
  if (!await tmuxExists(sessionName)) return;
  const initial = await inspectReusableTmuxWorker(sessionName, expected);
  await stopRevalidatedProcess(initial, {
    pid: initial.pid,
    uid: initial.uid,
    gid: initial.gid,
    argv: initial.argv,
  }, label);
  await removeDeadTmuxSession(sessionName, label);
}

async function processChildren(pid: number): Promise<readonly number[]> {
  let text: string;
  try { text = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8"); }
  catch (error) { if (!await readManagedProcessSnapshot(pid)) return Object.freeze([]); throw error; }
  const values = text.trim() ? text.trim().split(/\s+/u) : [];
  if (!values.every((value) => /^[1-9][0-9]*$/u.test(value))) throw new Error(`managed process children are invalid: ${pid}`);
  return Object.freeze(values.map(Number));
}

async function findExactManagedDescendant(rootPid: number, expected: ManagedProcessExpectation): Promise<ManagedProcessSnapshot> {
  const queue = [...await processChildren(rootPid)];
  const matches: ManagedProcessSnapshot[] = [];
  let inspected = 0;
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (++inspected > 16) throw new Error("managed process tree exceeds safety limits");
    const snapshot = await readManagedProcessSnapshot(pid);
    if (!snapshot) continue;
    if (isExactManagedProcess(snapshot, { ...expected, pid })) matches.push(snapshot);
    queue.push(...await processChildren(pid));
  }
  if (matches.length !== 1) throw new Error("managed process tree does not contain one exact service worker");
  return matches[0]!;
}

function coordinatorIdentity(): Readonly<{ uid: number; gid: number }> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) throw new Error("managed process ownership requires POSIX identity");
  return Object.freeze({ uid: uid!, gid: gid! });
}

function realmWorkerExpectation(mode: "realm" | "tunnel" | "ssh-tunnel" | "ssh-relay", pid?: number): ManagedProcessExpectation {
  void mode;
  return Object.freeze({
    ...coordinatorIdentity(),
    ...(pid === undefined ? {} : { pid }),
    argv: Object.freeze([process.execPath, workerPath, configPath]),
  });
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
  return Object.freeze(value.map((mount) => parseActiveGatewayMount(mount, { realmId: config.realm.id, stateDir })));
}

async function privateWrite(path: string, content: string): Promise<void> {
  const stage = `${path}.stage-${crypto.randomUUID()}`;
  try {
    await writeFile(stage, content, { flag: "wx", mode: 0o600 });
    await rename(stage, path);
    await chmod(path, 0o600);
  } finally { await rm(stage, { force: true }); }
}

async function sudo(command: readonly string[], failure: string): Promise<void> {
  const result = await run(["sudo", "-n", ...command]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || failure);
}

async function ensureGatewayServiceUser(key: string): Promise<Readonly<{ user: string; uid: number; gid: number; root: string }>> {
  if (process.platform !== "linux") throw new Error("Gateway process isolation currently requires Linux");
  const user = gatewayServiceUser(config.realm.id, stateDir, key);
  const root = gatewaySandboxRoot(config.realm.id, stateDir, key);
  const existing = await run(["getent", "passwd", user]);
  if (existing.code !== 0) {
    await sudo(["useradd", "--system", "--user-group", "--home-dir", root, "--shell", "/usr/sbin/nologin", user], "passwordless sudo is required to create an isolated Gateway service user");
  }
  const verified = await run(["getent", "passwd", user]);
  const fields = verified.stdout.trim().split(":");
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  if (verified.code !== 0 || fields.length !== 7 || fields[0] !== user || !Number.isSafeInteger(uid) || uid < 1
    || !Number.isSafeInteger(gid) || gid < 1 || fields[5] !== root || fields[6] !== "/usr/sbin/nologin") {
    throw new Error(`Gateway service user is unsafe: ${user}`);
  }
  await sudo(["install", "-d", "-m", "0711", "-o", "root", "-g", "root", "/var/lib/klivcore", "/var/lib/klivcore/gateways", root, `${root}/runtime`, `${root}/state`], "failed to prepare isolated Gateway directories");
  return Object.freeze({ user, uid, gid, root });
}

let sandboxBunPath: string | undefined;
async function ensureSandboxBun(): Promise<string> {
  if (sandboxBunPath) return sandboxBunPath;
  const data = await readFile(process.execPath);
  const digest = createHash("sha256").update(data).digest("hex");
  const target = `/var/lib/klivcore/bin/bun-${digest.slice(0, 16)}`;
  await sudo(["install", "-d", "-m", "0755", "-o", "root", "-g", "root", "/var/lib/klivcore/bin"], "failed to prepare the isolated Gateway Bun runtime");
  const current = await readFile(target).catch(() => undefined);
  if (!current || createHash("sha256").update(current).digest("hex") !== digest) {
    await sudo(["install", "-m", "0555", "-o", "root", "-g", "root", process.execPath, target], "failed to install the isolated Gateway Bun runtime");
  }
  const verified = await readFile(target);
  if (createHash("sha256").update(verified).digest("hex") !== digest) throw new Error("isolated Gateway Bun runtime verification failed");
  sandboxBunPath = target;
  return target;
}

async function ensureImmutableGatewayPackage(key: string, revision: string, sourceRoot: string): Promise<Readonly<{ packageRoot: string; packageDigest: string }>> {
  const packageDigest = await gatewayPackageDigest(sourceRoot);
  const packageRoot = gatewayImmutablePackageRoot(config.realm.id, stateDir, key, revision, packageDigest);
  const prefix = `${gatewaySandboxRoot(config.realm.id, stateDir, key)}/runtime/`;
  if (!packageRoot.startsWith(prefix)) throw new Error("Gateway package isolation path is invalid");
  let valid = false;
  try {
    const info = await lstat(packageRoot);
    valid = info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && (info.mode & 0o022) === 0
      && await gatewayPackageDigest(packageRoot) === packageDigest;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!valid) {
    await sudo(["rm", "-rf", "--", packageRoot], "failed to replace an invalid Gateway package");
    await sudo(["install", "-d", "-m", "0755", "-o", "root", "-g", "root", packageRoot], "failed to create immutable Gateway package root");
    await sudo(["cp", "-a", "--", `${sourceRoot}/.`, packageRoot], "failed to install Gateway package");
    await sudo(["chown", "-R", "root:root", packageRoot], "failed to secure Gateway package ownership");
    await sudo(["chmod", "-R", "u=rwX,go=rX", packageRoot], "failed to make Gateway package immutable");
  }
  const info = await lstat(packageRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0
    || await gatewayPackageDigest(packageRoot) !== packageDigest) throw new Error("immutable Gateway package verification failed");
  return Object.freeze({ packageRoot, packageDigest });
}

async function installGatewayConfigText(home: string, user: string, configPath: string, content: string): Promise<void> {
  await sudo(["install", "-d", "-m", "0700", "-o", user, "-g", user, home], "failed to prepare private Gateway state");
  const stage = resolve(stateDir, `.gateway-config-${crypto.randomUUID()}`);
  try {
    await writeFile(stage, content, { flag: "wx", mode: 0o600 });
    await sudo(["install", "-m", "0600", "-o", user, "-g", user, stage, configPath], "failed to install private Gateway configuration");
  } finally { await rm(stage, { force: true }); }
}

async function installGatewayConfig(home: string, user: string, configPath: string, value: Readonly<Record<string, unknown>>): Promise<void> {
  await installGatewayConfigText(home, user, configPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readGatewayConfigText(configPath: string, ownerUid: number): Promise<string> {
  const script = [
    "import os, stat, sys",
    "fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)",
    "info = os.fstat(fd)",
    "valid = stat.S_ISREG(info.st_mode) and info.st_uid == int(sys.argv[2]) and stat.S_IMODE(info.st_mode) == 0o600 and 1 < info.st_size <= 65536",
    "data = os.read(fd, 65537) if valid else b''",
    "os.close(fd)",
    "sys.exit(1) if (not valid or len(data) != info.st_size) else sys.stdout.buffer.write(data)",
  ].join("\n");
  const result = await run(["sudo", "-n", "python3", "-c", script, configPath, String(ownerUid)]);
  if (result.code !== 0) throw new Error("private Gateway configuration is unsafe or unreadable");
  return result.stdout;
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
  if (mount.manifest.server === null || mount.port === null) return true;
  try {
    const response = await fetch(`http://127.0.0.1:${mount.port}${mount.manifest.server.healthPath}`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const body = await response.json() as { status?: unknown };
    return body.status === "ok";
  } catch { return false; }
}

async function waitForGateway(mount: ActiveGatewayMount): Promise<void> {
  const serverRole = mount.manifest.server?.process;
  if (!serverRole) return;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!await tmuxExists(mount.sessions[serverRole]!)) throw await gatewayStartupFailure(mount, serverRole);
    if (await gatewayHealthy(mount)) return;
    await Bun.sleep(250);
  }
  const output = await gatewayProcessLogTail(mount, serverRole);
  throw new Error(`Gateway did not become healthy: ${mount.key}${output ? `\nGateway process log (redacted):\n${output}` : "\nGateway process log is empty"}`);
}

function gatewayProcessEnvironment(mount: ActiveGatewayMount): Readonly<Record<string, string>> {
  return Object.freeze({
    HOME: mount.home,
    PATH: "/var/lib/klivcore/bin:/usr/local/bin:/usr/bin:/bin",
    KLIVCORE_GATEWAY_MOUNT: mount.key,
    KLIVCORE_GATEWAY_HOME: mount.home,
    KLIVCORE_GATEWAY_CONFIG: mount.configPath,
    ...(mount.port === null ? {} : { KLIVCORE_GATEWAY_PORT: String(mount.port) }),
  });
}

const gatewaySupervisorModes = new Map<string, "portable" | "legacy">();

async function gatewayProcessSupervisorArgvForHost(
  uid: number,
  gid: number,
  environment: Readonly<Record<string, string>>,
  workerArgv: readonly string[],
): Promise<readonly string[]> {
  const key = `${uid}:${gid}`;
  let mode = gatewaySupervisorModes.get(key);
  if (!mode) {
    const portableProbe = gatewayProcessSupervisorArgv(uid, gid, {}, ["/usr/bin/true"]);
    if ((await run(portableProbe)).code === 0) mode = "portable";
    else {
      const legacyProbe = gatewayLegacyProcessSupervisorArgv(uid, gid, {}, ["/usr/bin/true"]);
      const legacy = await run(legacyProbe);
      if (legacy.code !== 0) throw new Error(legacy.stderr.trim() || "passwordless Gateway privilege drop is unavailable");
      mode = "legacy";
    }
    gatewaySupervisorModes.set(key, mode);
  }
  return mode === "portable"
    ? gatewayProcessSupervisorArgv(uid, gid, environment, workerArgv)
    : gatewayLegacyProcessSupervisorArgv(uid, gid, environment, workerArgv);
}

async function gatewayProcessExpectations(mount: ActiveGatewayMount, entrypoint: string): Promise<Readonly<{
  pane: ManagedProcessExpectation;
  worker: ManagedProcessExpectation;
}>> {
  const bunPath = await ensureSandboxBun();
  const workerArgv = Object.freeze([bunPath, resolve(mount.packageRoot, entrypoint)]);
  const paneArgv = await gatewayProcessSupervisorArgvForHost(mount.serviceUid, mount.serviceGid, gatewayProcessEnvironment(mount), workerArgv);
  return Object.freeze({
    pane: Object.freeze({ ...coordinatorIdentity(), gid: 0, argv: paneArgv }),
    worker: Object.freeze({ uid: mount.serviceUid, gid: mount.serviceGid, argv: workerArgv }),
  });
}

async function inspectOwnedGatewaySession(
  session: string,
  mount: ActiveGatewayMount,
  entrypoint: string,
): Promise<Readonly<{ pane: ManagedProcessSnapshot; worker: ManagedProcessSnapshot; expectations: Awaited<ReturnType<typeof gatewayProcessExpectations>> }>> {
  const expectations = await gatewayProcessExpectations(mount, entrypoint);
  const pane = await inspectCompatibleGatewayPane(session, expectations.pane, mount.serviceUid, mount.serviceGid);
  const worker = await findExactManagedDescendant(pane.pid, expectations.worker);
  return Object.freeze({ pane, worker, expectations });
}

async function gatewaySessionsOwned(mount: ActiveGatewayMount): Promise<boolean> {
  try {
    for (const process of mount.manifest.processes) {
      const session = mount.sessions[process.role];
      if (!session || !await tmuxExists(session)) return false;
      await inspectOwnedGatewaySession(session, mount, process.entrypoint);
    }
    return true;
  } catch { return false; }
}

async function tmuxSessionDead(session: string): Promise<boolean> {
  if (!await tmuxExists(session)) return true;
  const result = await tmux(["display-message", "-p", "-t", `=${session}:0.0`, "#{pane_dead}"]);
  if (result.code !== 0) {
    if (!await tmuxExists(session)) return true;
    throw new Error(result.stderr.trim() || `failed to inspect tmux session: ${session}`);
  }
  const value = result.stdout.trim();
  if (value !== "0" && value !== "1") throw new Error(`tmux session state is invalid: ${session}`);
  return value === "1";
}

async function assertGatewaySessionsRecoverable(mount: ActiveGatewayMount): Promise<void> {
  for (const process of mount.manifest.processes) {
    try {
      const session = mount.sessions[process.role];
      if (!session || !await tmuxExists(session) || await tmuxSessionDead(session)) continue;
      await inspectOwnedGatewaySession(session, mount, process.entrypoint);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Gateway orphan live session identity is invalid: ${mount.key}/${process.role}: ${detail}`, { cause: error });
    }
  }
}

async function readExactGatewayWorkerEnvironment(worker: ManagedProcessSnapshot): Promise<string> {
  const result = await run(["sudo", "-n", "cat", `/proc/${worker.pid}/environ`]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "failed to read owned Gateway worker environment");
  const current = await readManagedProcessSnapshot(worker.pid);
  if (!current || current.startTimeTicks !== worker.startTimeTicks || !isExactManagedProcess(current, {
    pid: worker.pid,
    uid: worker.uid,
    gid: worker.gid,
    argv: worker.argv,
  })) throw new Error("owned Gateway worker changed while recovering its environment");
  return result.stdout;
}

async function findOwnedGatewayWorkerFromImmutablePackage(
  rootPid: number,
  mount: ActiveGatewayMount,
  entrypoint: string,
  bunPath: string,
): Promise<Readonly<{ worker: ManagedProcessSnapshot; packageRoot: string }>> {
  const sandboxRoot = gatewaySandboxRoot(config.realm.id, stateDir, mount.key);
  const queue = [...await processChildren(rootPid)];
  const matches: Array<Readonly<{ worker: ManagedProcessSnapshot; packageRoot: string }>> = [];
  let inspected = 0;
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (++inspected > 16) throw new Error("managed process tree exceeds safety limits");
    const snapshot = await readManagedProcessSnapshot(pid);
    if (!snapshot) continue;
    if (snapshot.uid === mount.serviceUid && snapshot.gid === mount.serviceGid) {
      try {
        matches.push(Object.freeze({
          worker: snapshot,
          packageRoot: recoverGatewayPackageRootFromWorkerArgv(snapshot.argv, bunPath, sandboxRoot, entrypoint),
        }));
      } catch { /* not the bounded immutable Gateway worker */ }
    }
    queue.push(...await processChildren(pid));
  }
  if (matches.length !== 1) throw new Error("managed process tree does not contain one exact service worker");
  return matches[0]!;
}

async function recoverOwnedGatewayOrphan(mount: ActiveGatewayMount): Promise<ActiveGatewayMount | undefined> {
  const existing = await Promise.all(mount.manifest.processes.map(async (process) => await tmuxExists(mount.sessions[process.role]!)));
  if (existing.every((value) => !value)) return undefined;
  const bunPath = await ensureSandboxBun();
  let located: Readonly<{ worker: ManagedProcessSnapshot; packageRoot: string }> | undefined;
  for (const process of mount.manifest.processes) {
    const session = mount.sessions[process.role];
    if (!session || !await tmuxExists(session) || await tmuxSessionDead(session)) continue;
    const panePid = await tmuxPanePid(session);
    const pane = await readManagedProcessSnapshot(panePid);
    const identity = coordinatorIdentity();
    if (!pane || pane.uid !== identity.uid) throw new Error(`Gateway orphan supervisor identity is invalid: ${mount.key}/${process.role}`);
    located = await findOwnedGatewayWorkerFromImmutablePackage(pane.pid, mount, process.entrypoint, bunPath);
    break;
  }
  if (!located) return mount;
  const packageDigest = await gatewayPackageDigest(located.packageRoot);
  const packageName = basename(located.packageRoot);
  const revision = packageName.slice(0, 64);
  if (packageName !== `${revision}-${packageDigest.slice(0, 16)}`) {
    throw new Error(`Gateway orphan package identity is invalid: ${mount.key}`);
  }
  const manifest = await loadGatewayManifest(located.packageRoot);
  const sessions = Object.freeze(Object.fromEntries(manifest.processes.map((process) => [
    process.role,
    gatewayProcessSessionName(config.realm.id, stateDir, mount.key, process.role),
  ])));
  const recoveredBase = Object.freeze({
    ...mount,
    revision,
    packageDigest,
    packageRoot: located.packageRoot,
    sessions,
    manifest,
  });
  const port = recoverGatewayPortFromWorkerEnvironment(
    await readExactGatewayWorkerEnvironment(located.worker),
    gatewayProcessEnvironment(recoveredBase),
  );
  const recovered = Object.freeze({ ...recoveredBase, port });
  await assertGatewaySessionsRecoverable(recovered);
  return recovered;
}

async function writeActiveGateways(mounts: readonly ActiveGatewayMount[]): Promise<void> {
  if (mounts.length === 0) await rm(activeGatewaysPath, { force: true });
  else await privateWrite(activeGatewaysPath, `${JSON.stringify(mounts, null, 2)}\n`);
}

async function stopGatewaySessions(mount: ActiveGatewayMount): Promise<void> {
  const failures: unknown[] = [];
  for (const process of mount.manifest.processes) {
    const session = mount.sessions[process.role];
    if (!session) { failures.push(new Error(`Gateway process session is missing: ${mount.key}/${process.role}`)); continue; }
    try {
      if (!await tmuxExists(session)) continue;
      const label = `Gateway ${mount.key}/${process.role}`;
      if (await tmuxSessionDead(session)) { await removeDeadTmuxSession(session, label); continue; }
      const owned = await inspectOwnedGatewaySession(session, mount, process.entrypoint);
      await stopRevalidatedProcess(owned.worker, { ...owned.expectations.worker, pid: owned.worker.pid }, label);
      const deadline = Date.now() + 2_000;
      while (await tmuxExists(session) && Date.now() < deadline) await Bun.sleep(50);
      if (await tmuxExists(session)) {
        const pane = await inspectOwnedTmuxSession(session, { ...owned.expectations.pane, pid: owned.pane.pid });
        await stopRevalidatedProcess(pane, { ...owned.expectations.pane, pid: pane.pid }, `${label} supervisor`);
      }
      await removeDeadTmuxSession(session, label);
    } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw failures.length === 1 ? failures[0] : new AggregateError(failures, `Gateway session cleanup was incomplete: ${mount.key}`);
}

async function stopRecoveredGatewaySessions(mount: ActiveGatewayMount): Promise<void> {
  const recovered = await recoverOwnedGatewayOrphan(mount);
  if (recovered) await stopGatewaySessions(recovered);
}

function gatewayProcessLogPath(mount: ActiveGatewayMount, role: string): string {
  return resolve(stateDir, "logs", "gateways", `${mount.key}-${role}-${mount.revision.slice(0, 12)}.log`);
}

function redactGatewayLog(text: string): string {
  return text
    .replace(/https:\/\/[^\s]*\/auth\/register[^\s]*/giu, "[REDACTED registration URL]")
    .replace(/\b(token|secret|password|authorization)=\S+/giu, "$1=[REDACTED]")
    .replace(/[^\t\n\r\x20-\x7e]/gu, "?");
}

async function gatewayProcessLogTail(mount: ActiveGatewayMount, role: string): Promise<string> {
  let handle;
  try {
    handle = await open(gatewayProcessLogPath(mount, role), "r");
    const info = await handle.stat();
    const length = Math.min(info.size, 8 * 1024);
    const buffer = Buffer.alloc(8 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, info.size - length));
    return redactGatewayLog(buffer.subarray(0, bytesRead).toString("utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  } finally { await handle?.close(); }
}

async function gatewayStartupFailure(mount: ActiveGatewayMount, role: string): Promise<Error> {
  const output = await gatewayProcessLogTail(mount, role);
  return new Error(`Gateway server exited during startup: ${mount.key}${output ? `\nGateway process log (redacted):\n${output}` : "\nGateway process log is empty"}`);
}

async function startGatewayProcess(mount: ActiveGatewayMount, role: string, entrypoint: string): Promise<void> {
  const session = mount.sessions[role];
  if (!session) throw new Error(`Gateway process session is missing: ${mount.key}/${role}`);
  await readGatewayAsset(mount.packageRoot, entrypoint, 16 * 1024 * 1024);
  if (await gatewayPackageDigest(mount.packageRoot) !== mount.packageDigest) throw new Error(`Gateway package changed before process start: ${mount.key}`);
  const bunPath = await ensureSandboxBun();
  const argv = await gatewayProcessSupervisorArgvForHost(
    mount.serviceUid,
    mount.serviceGid,
    gatewayProcessEnvironment(mount),
    [bunPath, resolve(mount.packageRoot, entrypoint)],
  );
  const logPath = gatewayProcessLogPath(mount, role);
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  await privateWrite(logPath, "");
  const command = `exec ${argv.map(shellQuote).join(" ")} >> ${shellQuote(logPath)} 2>&1`;
  const started = await tmux(["new-session", "-d", "-s", session, "-c", mount.packageRoot, command]);
  if (started.code !== 0) throw new Error(started.stderr.trim() || `failed to start Gateway process ${mount.key}/${role}`);
}

async function startGatewayMount(mount: ActiveGatewayMount): Promise<void> {
  const server = mount.manifest.server === null
    ? undefined
    : mount.manifest.processes.find((process) => process.role === mount.manifest.server!.process);
  if (server) {
    await startGatewayProcess(mount, server.role, server.entrypoint);
    await waitForGateway(mount);
  }
  for (const process of mount.manifest.processes) {
    if (process.role !== server?.role) await startGatewayProcess(mount, process.role, process.entrypoint);
  }
  if (mount.manifest.processes.some((process) => process.role !== server?.role)) {
    await Bun.sleep(250);
    const dead = (await Promise.all(mount.manifest.processes
      .filter((process) => process.role !== server?.role)
      .map(async (process) => await tmuxExists(mount.sessions[process.role]!) ? undefined : process.role)))
      .find((role) => role !== undefined);
    if (dead) throw new Error(`Gateway utility process exited during startup: ${mount.key}/${dead}`);
  }
}

async function userOwnedAncestorDirectories(descendant: string): Promise<readonly string[]> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Default Workbench vault access requires a current user identity");
  const owned: string[] = [];
  for (let path = dirname(descendant);;) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Workbench vault ancestor is unsafe: ${path}`);
    if (info.uid === uid) owned.push(path);
    else if ((info.mode & 0o001) === 0) throw new Error(`Workbench vault ancestor is not traversable: ${path}`);
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
  return Object.freeze(owned);
}

function gatewayPathAccessAllows(
  info: Readonly<{ uid: number; gid: number; mode: number }>,
  serviceUid: number,
  serviceGid: number,
  required: number,
): boolean {
  const granted = info.uid === serviceUid ? (info.mode >> 6) & 0o7
    : info.gid === serviceGid ? (info.mode >> 3) & 0o7
      : info.mode & 0o7;
  return (granted & required) === required;
}

async function prepareWorkbenchVaultAccess(
  key: string,
  gatewayConfig: Readonly<Record<string, unknown>>,
  serviceUid: number,
  serviceGid: number,
): Promise<void> {
  if (key !== "workbench") return;
  const realmRoot = dirname(configPath);
  const vaultsRoot = resolve(realmRoot, "vaults");
  const configuredVaults = Array.isArray(gatewayConfig.vaults) ? gatewayConfig.vaults : undefined;
  const entries: ReadonlyArray<Readonly<{ id: string; root: string }>> = configuredVaults
    ? configuredVaults.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workbench vault config is invalid");
      const entry = value as Record<string, unknown>;
      if (typeof entry.id !== "string" || typeof entry.root !== "string") throw new Error("Workbench vault config is invalid");
      return Object.freeze({ id: entry.id, root: resolve(entry.root) });
    })
    : typeof gatewayConfig.vaultRoot === "string"
      ? [Object.freeze({ id: "main", root: resolve(gatewayConfig.vaultRoot) })]
      : [];
  const managed = new Map<string, Readonly<{ id: string; root: string }>>();
  for (const entry of entries) {
    const vaultRoot = entry.root;
    if (dirname(vaultRoot) !== vaultsRoot) continue;
    if (managed.has(vaultRoot)) throw new Error(`Workbench vault root is duplicated: ${vaultRoot}`);
    managed.set(vaultRoot, entry);
  }
  const vaultRoots = Object.freeze([...managed.keys()]);
  if (vaultRoots.length === 0) return;
  const uid = process.getuid?.();
  for (const path of [realmRoot, vaultsRoot, ...vaultRoots]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid)) {
      throw new Error(`Realm-local Workbench vault path must be an owned non-symlink directory: ${path}`);
    }
  }
  for (const vaultRoot of vaultRoots) {
    await sudo(["chgrp", "-R", String(serviceGid), "--", vaultRoot], "failed to share a Workbench vault with its isolated service");
    await sudo(["chmod", "-R", "g+rwX", "--", vaultRoot], "failed to grant the isolated Workbench service access to its vault");
    await sudo(["find", vaultRoot, "-type", "d", "-exec", "chmod", "g+s", "--", "{}", "+"], "failed to preserve a Workbench vault service group");
  }
  await sudo(["chgrp", String(serviceGid), "--", realmRoot, vaultsRoot], "failed to share Workbench vault parents");
  await sudo(["chmod", "g+x", "--", realmRoot, vaultsRoot], "failed to make Workbench vault parents traversable");
  const ancestors = await userOwnedAncestorDirectories(realmRoot);
  if (ancestors.length > 0) {
    await sudo(["chmod", "o+x", "--", ...ancestors], "failed to make user-owned Workbench vault ancestors traversable");
  }
  for (const vaultRoot of vaultRoots) {
    for (let path = vaultRoot;;) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || !gatewayPathAccessAllows(info, serviceUid, serviceGid, 0o1)) {
        throw new Error(`failed to verify isolated Workbench access to its vault: ${path}`);
      }
      const parent = dirname(path);
      if (parent === path) break;
      path = parent;
    }
    const vaultInfo = await lstat(vaultRoot);
    if (!gatewayPathAccessAllows(vaultInfo, serviceUid, serviceGid, 0o7)) {
      throw new Error(`failed to verify isolated Workbench access to its vault: ${vaultRoot}`);
    }
  }
  const initialView = gatewayConfig.initialView;
  const initialVaultId = initialView && typeof initialView === "object" && !Array.isArray(initialView)
    ? (initialView as Record<string, unknown>).vaultId : "main";
  const initialPath = typeof initialView === "string" ? initialView
    : initialView && typeof initialView === "object" && !Array.isArray(initialView)
      ? (initialView as Record<string, unknown>).path : undefined;
  const initialVault = entries.find((entry) => entry.id === initialVaultId && managed.has(entry.root));
  if (initialVault && typeof initialPath === "string") {
    const path = resolve(initialVault.root, initialPath);
    if (path !== initialVault.root && !path.startsWith(`${initialVault.root}/`)) throw new Error("Workbench initial view escapes its vault");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || !gatewayPathAccessAllows(info, serviceUid, serviceGid, 0o4)) {
      throw new Error(`failed to verify isolated Workbench access to its vault: ${path}`);
    }
  }
}

async function ensureGateways(): Promise<boolean> {
  const previous = await readActiveGateways();
  const configured = Object.entries(config.gateways ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const configuredKeys = new Set(configured.map(([key]) => key));
  let journal: readonly ActiveGatewayMount[] = previous.filter((mount) => configuredKeys.has(mount.key));
  let changed = false;
  for (const stale of previous.filter((mount) => !configuredKeys.has(mount.key))) {
    console.log(`Stopping disabled Gateway: ${stale.key}`);
    await stopGatewaySessions(stale);
    changed = true;
  }
  if (journal.length !== previous.length) await writeActiveGateways(journal);
  const active: ActiveGatewayMount[] = [];
  for (const [key, mountConfig] of configured) {
    const revision = gatewayMountRevision(key, mountConfig);
    const sourceRoot = await materializeGatewayPackage(key, mountConfig.source, revision);
    const isolation = await ensureGatewayServiceUser(key);
    await prepareWorkbenchVaultAccess(key, mountConfig.config, isolation.uid, isolation.gid);
    const immutable = await ensureImmutableGatewayPackage(key, revision, sourceRoot);
    const packageRoot = immutable.packageRoot;
    const manifest = await loadGatewayManifest(packageRoot);
    const home = gatewayDurableHome(config.realm.id, stateDir, key, mountConfig.storageSubdir);
    const configPath = resolve(home, "config.json");
    const prior = previous.find((candidate) => candidate.key === key);
    const priorConfig = prior?.configPath === configPath ? await readGatewayConfigText(configPath, isolation.uid) : undefined;
    await installGatewayConfig(home, isolation.user, configPath, mountConfig.config);
    const sessions = Object.freeze(Object.fromEntries(manifest.processes.map((process) => [
      process.role,
      gatewayProcessSessionName(config.realm.id, stateDir, key, process.role),
    ])));
    const unassigned = Object.freeze({
      schemaVersion: 1 as const,
      key,
      source: mountConfig.source,
      revision,
      packageDigest: immutable.packageDigest,
      serviceUser: isolation.user,
      serviceUid: isolation.uid,
      serviceGid: isolation.gid,
      baseRoute: mountConfig.baseRoute,
      storageSubdir: mountConfig.storageSubdir,
      packageRoot,
      home,
      configPath,
      port: null,
      sessions,
      manifest,
    });
    const occupied = await recoverOwnedGatewayOrphan(unassigned);
    const orphan = prior ? undefined : occupied;
    const candidate = Object.freeze({
      ...unassigned,
      port: manifest.server === null ? null : occupied?.port ?? prior?.port ?? await allocateGatewayPort(),
    });
    const authority = occupied ?? prior;
    const reusable = authority?.revision === candidate.revision && authority.source === candidate.source
      && authority.packageDigest === candidate.packageDigest && authority.serviceUser === candidate.serviceUser
      && authority.serviceUid === candidate.serviceUid && authority.serviceGid === candidate.serviceGid
      && authority.baseRoute === candidate.baseRoute && authority.storageSubdir === candidate.storageSubdir
      && authority.packageRoot === candidate.packageRoot && authority.home === candidate.home && authority.configPath === candidate.configPath
      && authority.port === candidate.port
      && await gatewayPackageDigest(candidate.packageRoot) === candidate.packageDigest
      && JSON.stringify(authority.sessions) === JSON.stringify(candidate.sessions)
      && await gatewaySessionsOwned(candidate)
      && await gatewayHealthy(candidate);
    if (reusable) {
      console.log(orphan
        ? `Reusing orphaned Gateway: ${key} (${revision.slice(0, 12)})`
        : `Reusing Gateway: ${key} (${revision.slice(0, 12)})`);
      active.push(candidate);
      journal = replaceActiveGatewayMount(journal, candidate);
      await writeActiveGateways(journal);
      continue;
    }
    console.log(`${prior ? "Updating" : orphan ? "Updating orphaned" : "Starting"} Gateway: ${key} (${revision.slice(0, 12)})`);
    const runtime = occupied ?? prior;
    try {
      if (runtime) await stopGatewaySessions(runtime);
      await startGatewayMount(candidate);
    } catch (replacementError) {
      await failAfterRollbackOperations(replacementError, `Gateway replacement rollback was incomplete: ${key}`, [
        async () => stopRecoveredGatewaySessions(candidate),
        ...(priorConfig !== undefined ? [async () => installGatewayConfigText(prior!.home, prior!.serviceUser, prior!.configPath, priorConfig)] : []),
        ...(prior ? [async () => startGatewayMount(prior)] : []),
        ...(orphan ? [async () => startGatewayMount(orphan)] : []),
      ]);
    }
    active.push(candidate);
    journal = replaceActiveGatewayMount(journal, candidate);
    await writeActiveGateways(journal);
    changed = true;
  }
  if (JSON.stringify(previous.map((mount) => ({ key: mount.key, revision: mount.revision, packageDigest: mount.packageDigest, baseRoute: mount.baseRoute, port: mount.port })))
    !== JSON.stringify(active.map((mount) => ({ key: mount.key, revision: mount.revision, packageDigest: mount.packageDigest, baseRoute: mount.baseRoute, port: mount.port })))) changed = true;
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
    const record = await readManagedTunnel(options);
    await inspectReusableTmuxWorker(options.sessionName, realmWorkerExpectation(options.workerMode, record.pid));
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

async function readAnyActiveSshRelay(): Promise<ReturnType<typeof parseActiveSshRelayRecord>> {
  await assertPrivateRecord(activeSshRelayPath);
  const record = parseActiveSshRelayRecord(
    JSON.parse(await readFile(activeSshRelayPath, "utf8")),
    config.realm.id,
    sshRelayPort,
    sessions.sshRelay,
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

async function reconcilePriorRealmDirectorySessions(): Promise<void> {
  const current = new Set(Object.values(sessions));
  const modes = ["ssh-tunnel", "ssh-relay", "tunnel", "realm"] as const;
  const stale = (await tmuxSessionNames()).flatMap((sessionName) => {
    if (current.has(sessionName)) return [];
    const mode = priorRealmDirectorySessionMode(sessionName, config.realm.id);
    return mode ? [{ mode, sessionName }] : [];
  }).sort((left, right) => modes.indexOf(left.mode) - modes.indexOf(right.mode));
  for (const { mode, sessionName } of stale) {
    const pid = await tmuxPanePid(sessionName);
    const snapshot = await readManagedProcessSnapshot(pid);
    const environment = snapshot ? await readManagedProcessEnvironment(pid) : Object.freeze({});
    if (!snapshot || !isStaleManagedRealmWorker(
      snapshot,
      { ...coordinatorIdentity(), executablePath: process.execPath },
      environment,
      config.realm.id,
      sessionName,
      mode,
    )) throw new Error(`refusing to replace an unverified stale Realm session: ${sessionName}`);
    console.log(`Stopping stale ${mode} session from a prior Realm directory: ${sessionName}`);
    await stopRevalidatedProcess(snapshot, { pid, uid: snapshot.uid, gid: snapshot.gid, argv: snapshot.argv }, `stale Realm ${mode}`);
    await removeDeadTmuxSession(sessionName, `stale Realm ${mode}`);
  }
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
      const owned = await readAnyActiveSshRelay();
      await stopOwnedTmuxSession(sessions.sshRelay, realmWorkerExpectation("ssh-relay", owned.pid), "SSH Core relay");
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
  if (await tmuxExists(sessions.sshTunnel)) {
    const tunnel = await readManagedTunnel({
      path: managedSshTunnelPath,
      port: sshRelayPort,
      sessionName: sessions.sshTunnel,
      workerMode: "ssh-tunnel",
      label: "managed SSH Quick Tunnel",
    });
    console.log(`Stopping disabled SSH Quick Tunnel session: ${sessions.sshTunnel}`);
    await stopOwnedTmuxSession(sessions.sshTunnel, realmWorkerExpectation("ssh-tunnel"), `SSH Quick Tunnel ${tunnel.sessionName}`);
  }
  if (await tmuxExists(sessions.sshRelay)) {
    const relay = await readAnyActiveSshRelay();
    console.log(`Stopping disabled SSH Core relay session: ${sessions.sshRelay}`);
    await stopOwnedTmuxSession(sessions.sshRelay, realmWorkerExpectation("ssh-relay", relay.pid), "SSH Core relay");
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

async function readOwnedRealmForReplacement(): Promise<ReturnType<typeof parseActiveRealmRecord> | undefined> {
  try {
    await assertPrivateRecord(activeRealmPath);
    const record = parseActiveRealmRecord(JSON.parse(await readFile(activeRealmPath, "utf8")), config.realm.id, config.port);
    return processIsAlive(record.pid) ? record : undefined;
  } catch { return undefined; }
}

async function stopOwnedRealmWorker(record: ReturnType<typeof parseActiveRealmRecord>): Promise<void> {
  const expected = realmWorkerExpectation("realm", record.pid);
  if (!isOwnedRealmWorkerCommand(expected.argv, process.execPath, workerPath, configPath)) {
    throw new Error("configured Realm worker identity is invalid");
  }
  await stopOwnedTmuxSession(sessions.realm, expected, "Realm worker");
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
      const ownedWorker = active ?? await readOwnedRealmForReplacement();
      console.log(active
        ? `Updating Realm runtime: ${active.runtimeRevision?.slice(0, 12) ?? "legacy"} -> ${runtimeRevision.slice(0, 12)}`
        : "Replacing Realm session with changed runtime endpoint configuration");
      if (!ownedWorker) throw new Error("refusing to replace a Realm session without an exact owned worker record");
      await stopOwnedRealmWorker(ownedWorker);
      await rm(activeRealmPath, { force: true });
    } else {
      console.log(`Reusing Realm session: ${sessions.realm} (${runtimeRevision.slice(0, 12)})`);
    }
  }
  if (!await tmuxExists(sessions.realm)) {
    const legacyWorker = await readOwnedRealmForReplacement();
    if (legacyWorker) {
      throw new Error("refusing to replace an active Realm worker outside its exact deterministic session");
    }
    await rm(activeRealmPath, { force: true });
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
await reconcilePriorRealmDirectorySessions();

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
