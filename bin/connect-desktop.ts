#!/usr/bin/env bun
import { main } from "../src/connect-desktop";

try { await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : "Connect Desktop failed");
  process.exitCode = 1;
}
