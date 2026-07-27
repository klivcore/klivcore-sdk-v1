import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseStartRealmConfig, type StartRealmArgs } from "./start-realm-core";

const SDK_REPOSITORY = "https://github.com/klivcore/klivcore-sdk-v1.git";
const CONFIG_NAME = "realm.config.json";
const REALM_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const USER = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u;

export type RealmDirectoryInvocation = StartRealmArgs & Readonly<{ realmDirectory: string }>;
export type LatestSdkExecution = Readonly<{ mode: "current" | "delegate"; revision: string }>;

export function planLatestSdkExecution(latestRevision: string, pinnedRevision?: string): LatestSdkExecution {
  if (!/^[a-f0-9]{40}$/u.test(latestRevision)) throw new TypeError("latest SDK revision is invalid");
  if (pinnedRevision !== undefined && !/^[a-f0-9]{40}$/u.test(pinnedRevision)) {
    throw new TypeError("pinned SDK revision is invalid");
  }
  return Object.freeze({ mode: pinnedRevision === latestRevision ? "current" : "delegate", revision: latestRevision });
}

export function resolveRealmDirectoryArgs(args: readonly string[], cwd = process.cwd()): RealmDirectoryInvocation {
  const command = args[0] === "registration-url" ? "registration-url" : "run";
  const directoryArgument = command === "registration-url" ? args[1] : args[0];
  if ((command === "run" && args.length !== 1) || (command === "registration-url" && args.length !== 2) || !directoryArgument) {
    throw new TypeError("Usage: start-realm <realm-directory> | start-realm registration-url <realm-directory>");
  }
  if (directoryArgument.split(/[\\/]/u).some((component) => component === "..")) {
    throw new TypeError("Realm directory name must not contain parent traversal");
  }
  const realmDirectory = resolve(cwd, directoryArgument);
  const realmId = basename(realmDirectory);
  if (!REALM_ID.test(realmId)) throw new TypeError("Realm directory name must be a valid Realm ID");
  return Object.freeze({ command, realmDirectory, configPath: join(realmDirectory, CONFIG_NAME) });
}

function realmName(id: string): string {
  return id.split("-").map((part) => part === "ec2" ? "EC2" : `${part[0]!.toUpperCase()}${part.slice(1)}`).join(" ");
}

function gatewaySource(revision: string, path: string): string {
  return `git+${SDK_REPOSITORY}#${revision}::${path}`;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  const uid = process.getuid?.();
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid)) {
    throw new Error(`Realm root must be an owned non-symlink directory: ${path}`);
  }
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function readExistingConfig(path: string): Promise<Record<string, unknown> | undefined> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const uid = process.getuid?.();
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024
    || (uid !== undefined && info.uid !== uid) || (process.platform !== "win32" && (info.mode & 0o022) !== 0)) {
    throw new Error(`Realm config must be an owned private regular file: ${path}`);
  }
  const parsed = parseStartRealmConfig(JSON.parse(await readFile(path, "utf8")));
  return { ...parsed, realm: { ...parsed.realm }, gateways: parsed.gateways ? { ...parsed.gateways } : {} };
}

async function atomicPrivateJson(path: string, value: unknown): Promise<void> {
  const stage = join(dirname(path), `.${basename(path)}.stage-${randomUUID()}`);
  try {
    await writeFile(stage, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(stage, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } finally {
    await rm(stage, { force: true });
  }
}

export async function reconcileRealmDirectory(
  realmDirectory: string,
  sdkRevision: string,
  options: Readonly<{ user?: string }> = {},
): Promise<string> {
  if (!/^[a-f0-9]{40}$/u.test(sdkRevision)) throw new TypeError("SDK revision must be a full lowercase Git commit");
  const resolvedDirectory = resolve(realmDirectory);
  const id = basename(resolvedDirectory);
  if (!REALM_ID.test(id)) throw new TypeError("Realm directory name must be a valid Realm ID");
  const user = options.user ?? process.env.USER;
  if (!user || !USER.test(user)) throw new Error("A valid current user is required to configure Realm Desktop access");
  await ensurePrivateDirectory(resolvedDirectory);
  const configPath = join(resolvedDirectory, CONFIG_NAME);
  const existing = await readExistingConfig(configPath);
  const gateways = existing?.gateways && typeof existing.gateways === "object" && !Array.isArray(existing.gateways)
    ? { ...existing.gateways as Record<string, unknown> } : {};
  const resourceMonitor = gateways["resource-monitor"] && typeof gateways["resource-monitor"] === "object" && !Array.isArray(gateways["resource-monitor"])
    ? gateways["resource-monitor"] as Record<string, unknown> : {};
  const workbench = gateways.workbench && typeof gateways.workbench === "object" && !Array.isArray(gateways.workbench)
    ? gateways.workbench as Record<string, unknown> : {};
  gateways["resource-monitor"] = {
    ...resourceMonitor,
    source: gatewaySource(sdkRevision, "gateways/resource-monitor"),
    baseRoute: "/resource-monitor",
    storageSubdir: "resource-monitor",
    config: resourceMonitor.config ?? { collectionIntervalMs: 5000 },
  };
  gateways.workbench = {
    ...workbench,
    source: gatewaySource(sdkRevision, "gateways/workbench"),
    baseRoute: "/workbench",
    storageSubdir: "workbench",
    config: workbench.config ?? {},
  };
  const config = existing ?? {
    schemaVersion: 1,
    realm: { id, name: realmName(id), canvasColor: "#101820" },
    port: 47002,
    stateDir: "./state",
    desktop: { ssh: { host: "127.0.0.1", port: 22, user, startingDirectory: resolvedDirectory } },
  };
  const reconciled = { ...config, gateways };
  parseStartRealmConfig(reconciled);
  await atomicPrivateJson(configPath, reconciled);
  return configPath;
}
