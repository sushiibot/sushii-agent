#!/usr/bin/env bun
import { runWsConsolidate } from "../src/workspace/wsConsolidate.ts";

process.exitCode = runWsConsolidate(process.argv.slice(2), {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
