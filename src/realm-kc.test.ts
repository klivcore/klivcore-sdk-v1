import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gatewayPackageDigest } from "./gateway-runtime";

const cliPath = resolve(import.meta.dir, "../bin/kc.ts");
const SDK_REVISION = "0123456789abcdef0123456789abcdef01234567";
const SDK_REVISION_RERUN = "89abcdef0123456789abcdef0123456789abcdef";
const GATEWAY_REVISION = "1".repeat(64);

let temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Realm kc command discovery", () => {
  test("discovers and runs a published Gateway tool without a source workspace", async () => {
    const fixture = await realmFixture();
    const plugins = run(fixture, ["plugins", "--json"]);
    expect(plugins.exitCode).toBe(0);
    expect(JSON.parse(plugins.stdout)).toEqual({
      commands: [{
        command: "bench",
        description: "Edit benches",
        gateway: "workbench",
      }],
      realmRoot: fixture.realmRoot,
    });

    const invocation = run(fixture, ["bench", "inspect", "relative.bench.hjson", "--json"]);
    expect(invocation.exitCode).toBe(0);
    expect(JSON.parse(invocation.stdout)).toEqual({
      args: ["inspect", "relative.bench.hjson", "--json"],
      cwd: fixture.cwd,
    });
  });

  test("preserves cwd, arguments, exit-code, and stdio when invoking a tool", async () => {
    const fixture = await realmFixture({
      toolScript: "console.error('bench-stderr'); console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })); process.exit(17);",
    });
    const invocation = run(fixture, ["bench", "inspect", "relative.bench.hjson"]);
    expect(invocation.exitCode).toBe(17);
    expect(invocation.stderr).toContain("bench-stderr");
    expect(JSON.parse(invocation.stdout)).toEqual({
      args: ["inspect", "relative.bench.hjson"],
      cwd: fixture.cwd,
    });
  });

  test("preserves explicit env forwarding for tool execution", async () => {
    const fixture = await realmFixture({
      toolScript: "console.log(process.env.KC_PINNED_CHILD_TEST || 'missing');",
    });
    const invocation = run(fixture, ["bench"], {
      env: { KC_PINNED_CHILD_TEST: "pinned-ok" },
    });
    expect(invocation.exitCode).toBe(0);
    expect(invocation.stdout.trim()).toBe("pinned-ok");
  });

  test("fails closed when the active Gateway registry is malformed", async () => {
    const fixture = await realmFixture();
    const statePath = join(fixture.realmRoot, "state", "active-gateways.json");
    await writeFile(statePath, "[{\"not-a-mount\":true}]\n", { mode: 0o600 });
    const result = run(fixture, ["plugins", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: expect.stringContaining("active Gateway record is invalid"),
    });
  });

  test("fails closed when the active Gateway registry is not private", async () => {
    if (process.platform === "win32") return;
    const fixture = await realmFixture();
    await chmod(join(fixture.realmRoot, "state", "active-gateways.json"), 0o644);
    const result = run(fixture, ["plugins", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: expect.stringContaining("unsafe active Gateway registry") });
  });

  test("fails closed when active Gateway registry root is tampered", async () => {
    const fixture = await realmFixture();
    const statePath = join(fixture.realmRoot, "state", "active-gateways.json");
    const mounts = JSON.parse(await readFile(statePath, "utf8"));
    mounts[0].packageDigest = "0".repeat(64);
    await writeFile(statePath, `${JSON.stringify(mounts)}\n`, { mode: 0o600 });
    const result = run(fixture, ["plugins", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: expect.stringContaining("Gateway package integrity check failed"),
    });
  });

  test("rejects a registered Realm with a relative root", async () => {
    const fixture = await realmFixture();
    const home = join(fixture.root, "home");
    const registrations = join(home, ".config", "klivcore", "realms");
    await mkdir(registrations, { recursive: true, mode: 0o700 });
    await writeFile(join(registrations, "test-realm.json"), `${JSON.stringify({ id: "test-realm", root: "relative-realm", schemaVersion: 1 })}\n`, { mode: 0o600 });
    const result = Bun.spawnSync(["bun", cliPath, "plugins", "--json"], {
      cwd: fixture.cwd,
      env: { ...process.env, HOME: home, KC_REALM_ROOT: undefined },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr.toString())).toMatchObject({ error: expect.stringContaining("Invalid Realm registration") });
  });

  test("fails when two mounted Gateways publish the same command", async () => {
    const fixture = await realmFixture({ duplicate: true });
    const result = run(fixture, ["plugins", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: expect.stringContaining("Duplicate kc command \"bench\"") });
  });
});

describe("start-realm kc registration", () => {
  test("installs a managed kc launcher and registers the Realm without overwriting unrelated launchers", async () => {
    const fixture = await realmFixture();
    const { installRealmKcRegistration } = await import("./realm-kc-registration");
    const home = fixture.home;
    const sourceEntrypoint = cliPath;
    await installRealmKcRegistration({ home, realmRoot: fixture.realmRoot, sdkRevision: SDK_REVISION, sourceEntrypoint });

    const launcher = await readFile(join(home, ".local", "bin", "kc"), "utf8");
    expect(launcher.startsWith("#!/bin/sh\n# klivcore managed realm kc\n")).toBe(true);
    expect(launcher).toContain("klivcore managed realm kc");
    expect(launcher).toContain(`${SDK_REVISION}`);
    expect(JSON.parse(await readFile(join(home, ".config", "klivcore", "realms", "test-realm.json"), "utf8"))).toEqual({
      id: "test-realm",
      root: fixture.realmRoot,
      schemaVersion: 1,
    });

    const registrationPath = join(home, ".config", "klivcore", "realms", "test-realm.json");
    const priorRegistration = `${JSON.stringify({ id: "test-realm", root: "/preserve/this/root", schemaVersion: 1 }, null, 2)}\n`;
    await writeFile(registrationPath, priorRegistration, { mode: 0o600 });
    await writeFile(join(home, ".local", "bin", "kc"), "#!/bin/sh\necho unrelated\n");
    await expect(installRealmKcRegistration({ home, realmRoot: fixture.realmRoot, sdkRevision: SDK_REVISION, sourceEntrypoint })).rejects.toThrow("unmanaged kc launcher");
    expect(await readFile(registrationPath, "utf8")).toBe(priorRegistration);
  });

  test("rewrites managed launcher when the SDK revision changes", async () => {
    const fixture = await realmFixture();
    const { installRealmKcRegistration } = await import("./realm-kc-registration");
    const home = fixture.home;
    const sourceEntrypoint = cliPath;

    await installRealmKcRegistration({
      home,
      realmRoot: fixture.realmRoot,
      sdkRevision: SDK_REVISION,
      sourceEntrypoint,
    });
    const initial = await readFile(join(home, ".local", "bin", "kc"), "utf8");

    await installRealmKcRegistration({
      home,
      realmRoot: fixture.realmRoot,
      sdkRevision: SDK_REVISION_RERUN,
      sourceEntrypoint,
    });
    const rerun = await readFile(join(home, ".local", "bin", "kc"), "utf8");

    expect(initial).toContain(SDK_REVISION);
    expect(rerun).toContain(SDK_REVISION_RERUN);
    expect(initial).not.toEqual(rerun);
  });

  test("registration enables kc bench discovery and execution", async () => {
    const fixture = await realmFixture();
    const { installRealmKcRegistration } = await import("./realm-kc-registration");
    const home = fixture.home;
    const sourceEntrypoint = cliPath;
    await installRealmKcRegistration({ home, realmRoot: fixture.realmRoot, sdkRevision: SDK_REVISION, sourceEntrypoint });

    const plugins = Bun.spawnSync(["bun", cliPath, "plugins", "--json"], {
      cwd: fixture.cwd,
      env: { ...process.env, HOME: home, KC_REALM_ROOT: fixture.realmRoot },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(plugins.exitCode).toBe(0);
    const pluginPayload = JSON.parse(plugins.stdout.toString());
    expect(pluginPayload.commands.some(({ command }) => command === "bench")).toBe(true);

    const invocation = Bun.spawnSync(["bun", cliPath, "bench", "inspect", "relative.bench.hjson"], {
      cwd: fixture.cwd,
      env: { ...process.env, HOME: home, KC_REALM_ROOT: fixture.realmRoot },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(invocation.exitCode).toBe(0);
    expect(JSON.parse(invocation.stdout.toString())).toEqual({
      args: ["inspect", "relative.bench.hjson"],
      cwd: fixture.cwd,
    });
  });
});

async function realmFixture(options: { duplicate?: boolean; toolScript?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "klivcore-realm-kc-"));
  temporaryDirectories.push(root);
  const realmRoot = join(root, "test-realm");
  const stateRoot = join(realmRoot, "state");
  const cwd = join(root, "agent-workspace");
  const home = join(root, "home");
  await mkdir(stateRoot, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(realmRoot, "realm.config.json"), `${JSON.stringify({
    schemaVersion: 1,
    realm: { id: "test-realm", name: "Test Realm", canvasColor: "#101820" },
    port: 47002,
    stateDir: "./state",
  })}\n`, { mode: 0o600 });

  const mounts = [await mountFixture(root, "workbench", "bench", options.toolScript)];
  if (options.duplicate) mounts.push(await mountFixture(root, "other", "bench", options.toolScript));
  await writeFile(join(stateRoot, "active-gateways.json"), `${JSON.stringify(mounts)}\n`, { mode: 0o600 });
  return { cwd, realmRoot, root, home };
}

async function mountFixture(
  root: string,
  gateway: string,
  command: string,
  toolScript = "console.log(JSON.stringify({ args: Bun.argv.slice(2), cwd: process.cwd() }));",
) {
  const sourcePackageRoot = join(root, `${gateway}-package-source`);
  await mkdir(join(sourcePackageRoot, "bin"), { recursive: true });
  await writeFile(join(sourcePackageRoot, "bin", "bench.js"), `${toolScript}\n`);
  await writeFile(
    join(sourcePackageRoot, "klivcore.gateway.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      contractVersion: 1,
      id: gateway,
      capabilities: [],
      routes: [{ id: "root", path: "/", title: "Root", requiredCapabilities: [], services: [], component: { id: "root", js: "ui.js", css: "ui.css" } }],
      processes: [],
      server: null,
      agentTools: [{ command, description: "Edit benches", entrypoint: "bin/bench.js" }],
    })}\n`,
  );
  const packageDigest = await gatewayPackageDigest(sourcePackageRoot);
  return {
    schemaVersion: 1,
    key: gateway,
    source: `git+https://github.com/klivcore/klivcore-sdk-v1.git#${SDK_REVISION}::gateways/${gateway}`,
    revision: GATEWAY_REVISION,
    packageDigest,
    serviceUser: `klivgw-${"3".repeat(20)}`,
    serviceUid: 1001,
    serviceGid: 1001,
    baseRoute: `/${gateway}`,
    storageSubdir: gateway,
    packageRoot: sourcePackageRoot,
    home: join(root, `${gateway}-home`),
    configPath: join(root, `${gateway}-home`, "config.json"),
    port: null,
    sessions: {},
    manifest: {
      schemaVersion: 1,
      contractVersion: 1,
      id: gateway,
      capabilities: [],
      routes: [{ id: "root", path: "/", title: "Root", requiredCapabilities: [], services: [], component: { id: "root", js: "ui.js", css: "ui.css" } }],
      server: null,
      processes: [],
      agentTools: [{ command, description: "Edit benches", entrypoint: "bin/bench.js" }],
    },
  };
}

function run(
  fixture: { cwd: string; realmRoot: string; root: string; home: string },
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
) {
  const result = Bun.spawnSync(["bun", cliPath, ...args], {
    cwd: fixture.cwd,
    env: { ...process.env, HOME: fixture.home, KC_REALM_ROOT: fixture.realmRoot, ...(options.env ?? {}) },
    stderr: "pipe",
    stdout: "pipe",
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString(), stdout: result.stdout.toString() };
}
