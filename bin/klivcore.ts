#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseAppV2LauncherArgs } from "../src/app-launcher-cli";
import { discoverGatewayAgentTools, resolveGatewayAgentTool } from "../src/gateway-runtime";
import { resolvePublishedAppV2Root, startAppV2Launcher } from "../src/app-launcher";

const args = Bun.argv.slice(2);
const command = args[0];
const gatewaysRoot = resolve(import.meta.dir, "../gateways");

async function listAgentTools() {
  if (args.length > 2 || (args[1] !== undefined && args[1] !== "--json")) throw new Error("Usage: sdk-v1 tools [--json]");
  const tools = (await discoverGatewayAgentTools(gatewaysRoot)).map(({ gateway, command, description }) => ({ gateway, command, description }));
  if (args[1] === "--json") {
    process.stdout.write(`${JSON.stringify({ tools }, null, 2)}\n`);
    return;
  }
  if (!tools.length) {
    process.stdout.write("No Gateway agent tools are published.\n");
    return;
  }
  for (const tool of tools) process.stdout.write(`${tool.gateway}/${tool.command}\t${tool.description}\n`);
  process.stdout.write("\nRun: sdk-v1 tool <gateway> <command> [args...]\n");
}

async function runAgentTool() {
  const gateway = args[1];
  const toolCommand = args[2];
  if (!gateway || !toolCommand) throw new Error("Usage: sdk-v1 tool <gateway> <command> [args...]");
  const tool = await resolveGatewayAgentTool(gatewaysRoot, gateway, toolCommand);
  const child = Bun.spawn([process.execPath, tool.entrypoint, ...args.slice(3)], {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
}

if (command === "tools") {
  try { await listAgentTools(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else if (command === "tool") {
  try { await runAgentTool(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else if (command === "start-realm") {
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
  const usage = `Klivcore App V2\n\nUsage: klivcore [tools [--json] | tool <gateway> <command> [args...] | start-realm <realm-directory> | connect-desktop <command> | --host 127.0.0.1|localhost|0.0.0.0] [--port 45174]\n`;
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
