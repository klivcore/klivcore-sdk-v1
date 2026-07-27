#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseAppV2LauncherArgs } from "../src/app-launcher-cli";
import { resolvePublishedAppV2Root, startAppV2Launcher } from "../src/app-launcher";

const args = Bun.argv.slice(2);
const command = args[0];

if (command === "start-realm") {
  process.argv = [process.argv[0]!, process.argv[1]!, ...args.slice(1)];
  await import("../src/start-realm-entry");
} else if (command === "connect-desktop") {
  process.argv = [process.argv[0]!, process.argv[1]!, ...args.slice(1)];
  const { main } = await import("../src/connect-desktop");
  try { await main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : "Connect Desktop failed");
    process.exitCode = 1;
  }
} else {
  const usage = `Klivcore App V2\n\nUsage: klivcore [start-realm <realm-directory> | connect-desktop <command> | --host 127.0.0.1|localhost|0.0.0.0] [--port 45174]\n`;
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage);
  } else {
    try {
      const options = parseAppV2LauncherArgs(args);
      const assetsRoot = await resolvePublishedAppV2Root(resolve(import.meta.dir, "../app-v2"));
      const launcher = await startAppV2Launcher({ assetsRoot, ...options });
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
}
