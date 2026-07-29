import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileRealmDirectory, resolveRealmDirectoryArgs } from "./start-realm-directory";
import { assertPriorRealmDirectoryMigrationAllowed, parseStartRealmArgs } from "./start-realm-core";

const temporaryDirectories: string[] = [];
const SDK_REVISION = "0123456789abcdef0123456789abcdef01234567";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("start-realm directory conflict guard", () => {
  test("propagates an explicit force flag through directory and coordinator argument parsing", () => {
    const directory = resolveRealmDirectoryArgs(["--force", "acme"], "/workspaces");
    expect(directory).toEqual({
      command: "run",
      realmDirectory: "/workspaces/acme",
      configPath: "/workspaces/acme/realm.config.json",
      forcePriorDirectory: true,
    });
    expect(parseStartRealmArgs(["--force", directory.configPath])).toEqual({
      command: "run",
      configPath: directory.configPath,
      forcePriorDirectory: true,
    });
  });

  test("refuses a live same-ID Realm from another directory unless force was explicit", () => {
    const stale = ["klivcore-acme-old-tunnel", "klivcore-acme-old-realm"];
    expect(() => assertPriorRealmDirectoryMigrationAllowed(stale, false)).toThrow(
      "already running from another directory",
    );
    expect(() => assertPriorRealmDirectoryMigrationAllowed(stale, false)).toThrow("--force");
    expect(() => assertPriorRealmDirectoryMigrationAllowed(stale, true)).not.toThrow();
  });
});

describe("reconcileRealmDirectory", () => {
  test("preserves existing service-group traversal on an active Realm root", async () => {
    if (process.platform === "win32") return;

    const parent = await mkdtemp(join(tmpdir(), "klivcore-start-realm-"));
    temporaryDirectories.push(parent);
    const realmDirectory = join(parent, "acme");
    const vaultRoot = join(realmDirectory, "vaults", "acme-vault");
    await mkdir(vaultRoot, { recursive: true, mode: 0o700 });
    await chmod(realmDirectory, 0o710);
    await writeFile(join(realmDirectory, "realm.config.json"), `${JSON.stringify({
      schemaVersion: 1,
      realm: { id: "acme", name: "Acme", canvasColor: "#101820" },
      port: 47002,
      stateDir: "./state",
      desktop: { ssh: { host: "127.0.0.1", port: 22, user: "vscode", startingDirectory: realmDirectory } },
      gateways: {
        workbench: {
          source: `git+https://github.com/klivcore/klivcore-sdk-v1.git#${SDK_REVISION}::gateways/workbench`,
          baseRoute: "/workbench",
          storageSubdir: "workbench",
          config: {
            initialView: { vaultId: "acme", path: "main.bench.hjson" },
            vaults: [{ id: "acme", root: vaultRoot }],
          },
        },
      },
    }, null, 2)}\n`, { mode: 0o600 });

    await reconcileRealmDirectory(realmDirectory, SDK_REVISION, { user: "vscode" });

    expect((await stat(realmDirectory)).mode & 0o777).toBe(0o710);
  });
});
