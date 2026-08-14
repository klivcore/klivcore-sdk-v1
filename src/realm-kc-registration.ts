import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const SDK_REPOSITORY = "https://github.com/klivcore/klivcore-sdk-v1.git";
const MANAGED_MARKER = "# klivcore managed realm kc";
const REALM_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

type RealmKcRegistrationOptions = Readonly<{
  home: string;
  realmRoot: string;
  sdkRevision: string;
  sourceEntrypoint: string;
}>;

export async function preflightRealmKcRegistration(options: RealmKcRegistrationOptions): Promise<void> {
  const home = await validateInputs(options);
  await assertManagedLauncherAvailable(resolve(home, ".local", "bin", "kc"));
}

export async function installRealmKcRegistration(options: RealmKcRegistrationOptions): Promise<void> {
  if (!/^[a-f0-9]{40}$/u.test(options.sdkRevision)) throw new TypeError("SDK revision must be a full lowercase Git commit");
  const home = await realpath(options.home).catch(async () => {
    await mkdir(options.home, { recursive: true, mode: 0o700 });
    return realpath(options.home);
  });
  const realmRoot = await realpath(options.realmRoot);
  const id = basename(realmRoot);
  if (!REALM_ID.test(id)) throw new TypeError("Realm directory name must be a valid Realm ID");
  if (!(await stat(options.sourceEntrypoint)).isFile()) throw new Error("Realm kc source entrypoint is invalid");

  const registrations = resolve(home, ".config", "klivcore", "realms");
  const bin = resolve(home, ".local", "bin");
  const launcherPath = resolve(bin, "kc");
  await assertManagedLauncherAvailable(launcherPath);
  await Promise.all([privateDirectory(registrations), privateDirectory(bin)]);
  await atomicFile(resolve(registrations, `${id}.json`), `${JSON.stringify({ id, root: realmRoot, schemaVersion: 1 }, null, 2)}\n`, 0o600);

  const launcher = [
    "#!/bin/sh",
    MANAGED_MARKER,
    `exec bunx --bun --package '${SDK_REPOSITORY}#${options.sdkRevision}' kc \"$@\"`,
    "",
  ].join("\n");
  await atomicFile(launcherPath, launcher, 0o700);
}

async function validateInputs(options: RealmKcRegistrationOptions): Promise<string> {
  if (!/^[a-f0-9]{40}$/u.test(options.sdkRevision)) throw new TypeError("SDK revision must be a full lowercase Git commit");
  const home = await realpath(options.home);
  const realmRoot = await realpath(options.realmRoot);
  if (!REALM_ID.test(basename(realmRoot))) throw new TypeError("Realm directory name must be a valid Realm ID");
  if (!(await stat(options.sourceEntrypoint)).isFile()) throw new Error("Realm kc source entrypoint is invalid");
  return home;
}

async function assertManagedLauncherAvailable(launcherPath: string): Promise<void> {
  let existing: string | undefined;
  try {
    const info = await lstat(launcherPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing to replace unmanaged kc launcher: ${launcherPath}`);
    existing = await readFile(launcherPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing !== undefined && !existing.startsWith(`#!/bin/sh\n${MANAGED_MARKER}\n`)) {
    throw new Error(`Refusing to replace unmanaged kc launcher: ${launcherPath}`);
  }
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  const uid = process.getuid?.();
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid)) throw new Error(`Unsafe Realm kc directory: ${path}`);
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function atomicFile(path: string, content: string, mode: number): Promise<void> {
  const stage = resolve(dirname(path), `.${basename(path)}.stage-${randomUUID()}`);
  try {
    await writeFile(stage, content, { flag: "wx", mode });
    await rename(stage, path);
    if (process.platform !== "win32") await chmod(path, mode);
  } finally {
    await rm(stage, { force: true });
  }
}
