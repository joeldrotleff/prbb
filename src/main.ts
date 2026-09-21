#!/usr/bin/env bun
import { runCli } from "./cli.ts";

await runCli(process.argv.slice(2));
