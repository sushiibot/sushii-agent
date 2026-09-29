#!/usr/bin/env bun
import { runWsSchedule } from "../src/workspace/wsSchedule.ts";

process.exitCode = runWsSchedule(process.argv.slice(2), {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
