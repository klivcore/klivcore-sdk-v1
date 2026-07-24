import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  effectiveSshdUsesAuthorizedKeysFile,
  formatRegistrationUrlBlock,
  parseActiveRealmRecord,
  parseManagedTunnelRecord,
  parseStartRealmArgs,
  parseStartRealmConfig,
  probeHealthInFreshBun,
  probePublicHealth,
  renderLoopbackSshdDropIn,
  startRealmSessionNames,
  type ManagedTunnelRecord,
} from "./start-realm-core";

const rawArgs = process.argv.slice(2);
const invocation = parseStartRealmArgs(rawArgs);
const configPath = resolve(invocation.configPath);
const config = parseStartRealmConfig(JSON.parse(await readFile(configPath, "utf8")));
const stateDir = resolve(dirname(configPath), config.stateDir);
const activeRealmPath = resolve(stateDir, "active-realm.json");
const managedTunnelPath = resolve(stateDir, "managed-tunnel.json");
const workerPath = resolve(import.meta.dir, "start-realm.ts");
const sessions = startRealmSessionNames(config.realm.id, stateDir);

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

async function tmuxOutput(sessionName: string): Promise<string> {
  const result = await tmux(["capture-pane", "-p", "-t", `${sessionName}:0.0`, "-S", "-80"]);
  if (result.code === 0) return result.stdout.trim();
  const logPath = resolve(stateDir, sessionName === sessions.tunnel ? "managed-tunnel.log" : "realm.log");
  return readFile(logPath, "utf8").then((value) => value.trim()).catch(() => result.stderr.trim());
}

async function startTmuxWorker(sessionName: string, environment: Readonly<Record<string, string>>): Promise<void> {
  const logPath = resolve(stateDir, sessionName === sessions.tunnel ? "managed-tunnel.log" : "realm.log");
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

async function readManagedTunnel(): Promise<ManagedTunnelRecord> {
  await assertPrivateRecord(managedTunnelPath);
  const record = parseManagedTunnelRecord(
    JSON.parse(await readFile(managedTunnelPath, "utf8")),
    config.realm.id,
    config.port,
    sessions.tunnel,
  );
  if (!processIsAlive(record.pid)) throw new Error("managed tunnel worker is not running");
  return record;
}

async function waitForManagedTunnel(): Promise<ManagedTunnelRecord> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (!await tmuxExists(sessions.tunnel)) {
      throw new Error(`managed tunnel session exited during startup\n${await tmuxOutput(sessions.tunnel)}`);
    }
    try { return await readManagedTunnel(); } catch { await Bun.sleep(500); }
  }
  throw new Error(`managed tunnel did not publish its origin\n${await tmuxOutput(sessions.tunnel)}`);
}

async function ensureManagedTunnel(): Promise<ManagedTunnelRecord> {
  if (await tmuxExists(sessions.tunnel)) {
    console.log(`Reusing managed Quick Tunnel session: ${sessions.tunnel}`);
    return waitForManagedTunnel();
  }
  await rm(managedTunnelPath, { force: true });
  console.log(`Starting managed Quick Tunnel session: ${sessions.tunnel}`);
  await startTmuxWorker(sessions.tunnel, {
    KLIVCORE_START_REALM_MODE: "tunnel",
    KLIVCORE_START_REALM_TUNNEL_SESSION: sessions.tunnel,
  });
  return waitForManagedTunnel();
}

async function readActiveRealm(expectedPublicOrigin: string): Promise<ReturnType<typeof parseActiveRealmRecord>> {
  await assertPrivateRecord(activeRealmPath);
  const record = parseActiveRealmRecord(
    JSON.parse(await readFile(activeRealmPath, "utf8")),
    config.realm.id,
    config.port,
    expectedPublicOrigin,
  );
  if (!processIsAlive(record.pid)) throw new Error("Realm worker is not running");
  return record;
}

async function waitForRealm(expectedPublicOrigin: string): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  let nextReport = Date.now();
  while (Date.now() < deadline) {
    if (!await tmuxExists(sessions.realm)) {
      throw new Error(`Realm session exited during startup\n${await tmuxOutput(sessions.realm)}`);
    }
    try {
      const record = await readActiveRealm(expectedPublicOrigin);
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

async function ensureRealm(publicOrigin: string, tunnelPid?: number): Promise<void> {
  if (await tmuxExists(sessions.realm)) {
    let active: Awaited<ReturnType<typeof readActiveRealm>> | undefined;
    try { active = await readActiveRealm(publicOrigin); } catch { /* readiness below reports invalid workers */ }
    if (active && active.runtimeRevision !== runtimeRevision) {
      console.log(`Updating Realm runtime: ${active.runtimeRevision?.slice(0, 12) ?? "legacy"} -> ${runtimeRevision.slice(0, 12)}`);
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
      KLIVCORE_START_REALM_RUNTIME_REVISION: runtimeRevision,
      ...(tunnelPid ? { KLIVCORE_START_REALM_TUNNEL_PID: String(tunnelPid) } : {}),
    });
  }
  await waitForRealm(publicOrigin);
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

const tunnel = config.publicOrigin ? undefined : await ensureManagedTunnel();
const publicOrigin = config.publicOrigin ?? tunnel!.publicOrigin;
await ensureRealm(publicOrigin, tunnel?.pid);
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
console.log("Restart only a broken component:");
console.log(`  Realm:  tmux kill-session -t ${sessions.realm}; rerun this start-realm command`);
if (tunnel) console.log(`  Tunnel: tmux kill-session -t ${sessions.tunnel}; tmux kill-session -t ${sessions.realm}; rerun this start-realm command`);
