#!/usr/bin/env bun
import { pinnedAgentDirs } from "../src/workspace/sessionPaths.ts";
import { runWsRuns } from "../src/workspace/wsRuns.ts";

process.exitCode = runWsRuns(process.argv.slice(2), {
  env: process.env,
  agentDirs: pinnedAgentDirs(),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
