import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePublishedAppV2Root, startAppV2Launcher } from "./app-launcher";

const roots: string[] = [];
const launchers: Array<{ stop(): void }> = [];
afterEach(async () => {
  for (const launcher of launchers.splice(0)) launcher.stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function assetsFixture() {
  const root = await mkdtemp(join(tmpdir(), "klivcore-sdk-launcher-"));
  roots.push(root);
  await mkdir(join(root, "assets"), { recursive: true });
  const index = "<!doctype html><main>Empty Klivcore App</main>\n";
  const script = "document.body.dataset.ready='true'\n";
  await writeFile(join(root, "index.html"), index);
  await writeFile(join(root, "assets", "app.js"), script);
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    source: { package: "@klivcore/app-v2", version: "1.0.0" },
    files: [
      { path: "assets/app.js", bytes: Buffer.byteLength(script), sha256: sha256(script) },
      { path: "index.html", bytes: Buffer.byteLength(index), sha256: sha256(index) },
    ],
  }, null, 2)}\n`);
  return root;
}

describe("SDK App V2 launcher", () => {
  test("resolves only a bounded content-addressed publication pointer", async () => {
    const assetsRoot = await assetsFixture();
    const publicationRoot = await mkdtemp(join(tmpdir(), "klivcore-sdk-publication-"));
    roots.push(publicationRoot);
    const release = sha256(await readFile(join(assetsRoot, "manifest.json"), "utf8"));
    await mkdir(join(publicationRoot, "releases"));
    await rename(assetsRoot, join(publicationRoot, "releases", release));
    await writeFile(join(publicationRoot, "current.json"), JSON.stringify({ schemaVersion: 1, release }));

    expect(await resolvePublishedAppV2Root(publicationRoot)).toBe(join(publicationRoot, "releases", release));

    const mismatchedRelease = "a".repeat(64);
    await cp(join(publicationRoot, "releases", release), join(publicationRoot, "releases", mismatchedRelease), { recursive: true });
    await writeFile(join(publicationRoot, "current.json"), JSON.stringify({ schemaVersion: 1, release: mismatchedRelease }));
    await expect(resolvePublishedAppV2Root(publicationRoot)).rejects.toThrow("content address");
  });

  test("verifies and serves the published empty App with SPA route fallback", async () => {
    const assetsRoot = await assetsFixture();
    const launcher = await startAppV2Launcher({ assetsRoot, hostname: "127.0.0.1", port: 0 });
    launchers.push(launcher);
    await rm(assetsRoot, { recursive: true });

    const index = await fetch(launcher.url);
    const script = await fetch(new URL("/assets/app.js", launcher.url));
    const route = await fetch(new URL("/operations", launcher.url));
    const mutation = await fetch(launcher.url, { method: "POST" });

    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("Empty Klivcore App");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(await script.text()).toContain("dataset.ready");
    expect(await route.text()).toContain("Empty Klivcore App");
    expect(mutation.status).toBe(405);
    expect(launcher.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  test("fails before listening when a published asset no longer matches its manifest", async () => {
    const assetsRoot = await assetsFixture();
    await writeFile(join(assetsRoot, "assets", "app.js"), "tampered\n");

    await expect(startAppV2Launcher({ assetsRoot, hostname: "127.0.0.1", port: 0 })).rejects.toThrow("integrity check failed");
  });
});
