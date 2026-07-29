import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileRealmDirectory } from "./start-realm-directory";

const temporaryDirectories: string[] = [];
const SDK_REVISION = "0123456789abcdef0123456789abcdef01234567";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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
