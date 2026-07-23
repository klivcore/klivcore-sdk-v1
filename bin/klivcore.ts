#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseAppV2LauncherArgs } from "../src/app-launcher-cli";
import { resolvePublishedAppV2Root, startAppV2Launcher } from "../src/app-launcher";

const usage = `Klivcore App V2

Usage: klivcore [--host 127.0.0.1|localhost|0.0.0.0] [--port 45174]

Starts the empty local Klivcore App launcher. Connect to a Realm from the App.
`;

if (Bun.argv.slice(2).includes("--help") || Bun.argv.slice(2).includes("-h")) {
  process.stdout.write(usage);
} else {
  try {
    const options = parseAppV2LauncherArgs(Bun.argv.slice(2));
    const assetsRoot = await resolvePublishedAppV2Root(resolve(import.meta.dir, "../app-v2"));
    const launcher = await startAppV2Launcher({
      assetsRoot,
      ...options,
    });
    process.stdout.write(`Klivcore App V2: ${launcher.url}\nPress Ctrl+C to stop.\n`);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      launcher.stop();
      process.exitCode = 0;
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    process.stderr.write(`Klivcore App V2 failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
