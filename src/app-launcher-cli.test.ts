import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseAppV2LauncherArgs } from "./app-launcher-cli";

describe("SDK App V2 launcher CLI", () => {
  test("declares the executable name Bun infers from the scoped SDK package", async () => {
    const packageJson = JSON.parse(await readFile(resolve(import.meta.dir, "../package.json"), "utf8"));
    expect(packageJson.bin["sdk-v1"]).toBe("./bin/klivcore.ts");
  });

  test("defaults to the dedicated local App V2 address", () => {
    expect(parseAppV2LauncherArgs([])).toEqual({ hostname: "127.0.0.1", port: 45174 });
  });

  test("accepts explicit local host and port", () => {
    expect(parseAppV2LauncherArgs(["--host", "0.0.0.0", "--port", "48080"])).toEqual({ hostname: "0.0.0.0", port: 48080 });
  });

  test("rejects unknown, missing, and invalid arguments", () => {
    expect(() => parseAppV2LauncherArgs(["--realm", "acme"])).toThrow("unknown argument");
    expect(() => parseAppV2LauncherArgs(["--port"])).toThrow("requires a value");
    expect(() => parseAppV2LauncherArgs(["--port", "0"])).toThrow("port must be between 1 and 65535");
  });
});
