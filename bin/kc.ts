#!/usr/bin/env bun
import { runRealmKc } from "../src/realm-kc";

process.exitCode = await runRealmKc(Bun.argv.slice(2));
