import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import {
  gatewayPackageDigest,
  loadGatewayManifest,
  parseActiveGatewayMount,
  type DiscoveredGatewayAgentTool,
} from "./gateway-runtime";
import { parseStartRealmConfig } from "./start-realm-core";

const REALM_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

type RealmRegistration = Readonly<{ id: string; root: string; schemaVersion: 1 }>;
type RealmTool = Readonly<DiscoveredGatewayAgentTool & { packageRoot: string }>;

export async function runRealmKc(
  args: readonly string[],
  options: Readonly<{
    cwd?: string;
    env?: Readonly<Record<string, string | undefined>>;
    home?: string;
    stderr?: (value: string) => void;
    stdout?: (value: string) => void;
  }> = {},
): Promise<number> {
  const stdout = options.stdout ?? ((value) => process.stdout.write(value));
  const stderr = options.stderr ?? ((value) => process.stderr.write(value));
  const jsonErrors = args[0] === "plugins" && args.includes("--json");
  try {
    const cwd = resolve(options.cwd ?? process.cwd());
    const env = options.env ?? process.env;
    const home = resolve(options.home ?? env.HOME ?? homedir());
    const realmRoot = await selectRealmRoot(cwd, home, env.KC_REALM_ROOT);
    const tools = await discoverRealmTools(realmRoot);
    const [command, ...commandArgs] = args;
    if (!command || command === "help" || command === "--help" || command === "-h") {
      stdout(formatHelp(tools));
      return 0;
    }
    if (command === "plugins") {
      if (commandArgs.some((argument) => argument !== "--json")) throw new Error("Usage: kc plugins [--json]");
      if (commandArgs.includes("--json")) {
        stdout(`${JSON.stringify({
          commands: tools.map(({ command: name, description, gateway }) => ({ command: name, description, gateway })),
          realmRoot,
        }, null, 2)}\n`);
      } else {
        stdout(`${tools.map((tool) => `${tool.command}\t${tool.gateway}\t${tool.description}`).join("\n")}\n`);
      }
      return 0;
    }
    const tool = tools.find((candidate) => candidate.command === command);
    if (!tool) throw new Error(`Unknown kc command "${command}". Run kc --help to list commands.`);
    const child = Bun.spawn([process.execPath, tool.entrypoint, ...commandArgs], {
      cwd,
      env: { ...env, KC_COMMAND: tool.command, KC_GATEWAY: tool.gateway, KC_REALM_ROOT: realmRoot },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return await child.exited;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(jsonErrors ? `${JSON.stringify({ error: message })}\n` : `kc: ${message}\n`);
    return 1;
  }
}

async function selectRealmRoot(cwd: string, home: string, configured?: string): Promise<string> {
  if (configured) return await validateRealmRoot(resolve(configured));
  for (let candidate = cwd;;) {
    try { return await validateRealmRoot(candidate); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Missing Realm config:")) throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  const registrations = await readRealmRegistrations(home);
  if (registrations.length === 1) return await validateRealmRoot(registrations[0]!.root);
  if (registrations.length === 0) throw new Error("No registered Realm was found. Run start-realm first or set KC_REALM_ROOT.");
  throw new Error(`Multiple Realms are registered (${registrations.map((entry) => entry.id).join(", ")}). Set KC_REALM_ROOT.`);
}

async function validateRealmRoot(root: string): Promise<string> {
  const canonical = await realpath(root).catch(() => { throw new Error(`Missing Realm config: ${resolve(root, "realm.config.json")}`); });
  const configPath = resolve(canonical, "realm.config.json");
  const info = await lstat(configPath).catch(() => { throw new Error(`Missing Realm config: ${configPath}`); });
  const uid = process.getuid?.();
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 64 * 1024
    || (uid !== undefined && info.uid !== uid) || (process.platform !== "win32" && (info.mode & 0o022) !== 0)) {
    throw new Error(`Unsafe Realm config: ${configPath}`);
  }
  return canonical;
}

async function readRealmRegistrations(home: string): Promise<readonly RealmRegistration[]> {
  const directory = resolve(home, ".config", "klivcore", "realms");
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const registrations: RealmRegistration[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
    const path = resolve(directory, entry.name);
    const info = await lstat(path);
    const uid = process.getuid?.();
    if ((process.platform !== "win32" && (info.mode & 0o777) !== 0o600) || (uid !== undefined && info.uid !== uid)) {
      throw new Error(`Unsafe Realm registration: ${path}`);
    }
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<RealmRegistration>;
    if (value.schemaVersion !== 1 || typeof value.id !== "string" || !REALM_ID.test(value.id)
      || typeof value.root !== "string" || !isAbsolute(value.root)) throw new Error(`Invalid Realm registration: ${path}`);
    registrations.push(Object.freeze({ id: value.id, root: value.root, schemaVersion: 1 }));
  }
  return Object.freeze(registrations);
}

async function discoverRealmTools(realmRoot: string): Promise<readonly RealmTool[]> {
  const configPath = resolve(realmRoot, "realm.config.json");
  const config = parseStartRealmConfig(JSON.parse(await readFile(configPath, "utf8")));
  const stateDir = resolve(realmRoot, config.stateDir);
  const registryPath = resolve(stateDir, "active-gateways.json");
  const info = await lstat(registryPath);
  const uid = process.getuid?.();
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 1024 * 1024
    || (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) || (uid !== undefined && info.uid !== uid)) {
    throw new Error("unsafe active Gateway registry");
  }
  const value = JSON.parse(await readFile(registryPath, "utf8"));
  if (!Array.isArray(value) || value.length > 32) throw new Error("active Gateway registry is invalid");
  const tools: RealmTool[] = [];
  for (const raw of value) {
    const mount = parseActiveGatewayMount(raw, { realmId: config.realm.id, stateDir });
    const canonicalPackageRoot = await realpath(mount.packageRoot);
    if (mount.packageDigest !== await gatewayPackageDigest(canonicalPackageRoot)) {
      throw new Error(`Gateway package integrity check failed: ${mount.key}`);
    }
    const manifest = await loadGatewayManifest(canonicalPackageRoot);
    for (const tool of manifest.agentTools ?? []) {
      const entrypoint = resolve(canonicalPackageRoot, tool.entrypoint);
      const canonicalEntrypoint = await realpath(entrypoint);
      const packageRelative = relative(canonicalPackageRoot, canonicalEntrypoint);
      const entryInfo = await stat(canonicalEntrypoint);
      if (packageRelative === ".." || packageRelative.startsWith(`..${sep}`) || !entryInfo.isFile()) {
        throw new Error(`Gateway agent tool is invalid: ${mount.key}/${tool.command}`);
      }
      tools.push(Object.freeze({ gateway: mount.key, ...tool, entrypoint: canonicalEntrypoint, packageRoot: canonicalPackageRoot }));
    }
  }
  tools.sort((left, right) => left.command.localeCompare(right.command) || left.gateway.localeCompare(right.gateway));
  const commands = new Map<string, RealmTool>();
  for (const tool of tools) {
    const existing = commands.get(tool.command);
    if (existing) throw new Error(`Duplicate kc command "${tool.command}" from Gateways ${existing.gateway} and ${tool.gateway}`);
    commands.set(tool.command, tool);
  }
  return Object.freeze(tools);
}

function formatHelp(tools: readonly RealmTool[]): string {
  return [
    "kc — Klivcore Realm CLI",
    "",
    "Usage:",
    "  kc <command> [args...]",
    "  kc plugins [--json]",
    "",
    "Commands:",
    ...tools.map((tool) => `  ${tool.command.padEnd(16)}${tool.description}`),
    "  plugins         List active Realm commands and provenance",
    "",
  ].join("\n");
}
