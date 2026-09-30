import simpleGit, { type SimpleGit, type SimpleGitOptions } from "simple-git";
import { withoutOrchEnv } from "./agentEnv.ts";

type UnsafeFlag = keyof NonNullable<SimpleGitOptions["unsafe"]>;

// simple-git rejects an explicit env carrying these vars unless allowed. They come from the process's
// own env, which git would inherit anyway, so allow exactly the ones present.
const UNSAFE_ENV_FLAGS: Record<string, UnsafeFlag> = {
  EDITOR: "allowUnsafeEditor",
  GIT_ASKPASS: "allowUnsafeAskPass",
  SSH_ASKPASS: "allowUnsafeAskPass",
  GIT_CONFIG: "allowUnsafeConfigPaths",
  GIT_CONFIG_GLOBAL: "allowUnsafeConfigPaths",
  GIT_CONFIG_SYSTEM: "allowUnsafeConfigPaths",
  GIT_EXEC_PATH: "allowUnsafeConfigPaths",
  PREFIX: "allowUnsafeConfigPaths",
  GIT_CONFIG_COUNT: "allowUnsafeConfigEnvCount",
  GIT_EDITOR: "allowUnsafeEditor",
  GIT_SEQUENCE_EDITOR: "allowUnsafeEditor",
  GIT_EXTERNAL_DIFF: "allowUnsafeDiffExternal",
  GIT_PAGER: "allowUnsafePager",
  PAGER: "allowUnsafePager",
  GIT_PROXY_COMMAND: "allowUnsafeGitProxy",
  GIT_TEMPLATE_DIR: "allowUnsafeTemplateDir",
  GIT_SSH: "allowUnsafeSshCommand",
  GIT_SSH_COMMAND: "allowUnsafeSshCommand",
};

/** The env every host-side git invocation gets. Agents can plant repo config (core.fsmonitor,
 *  hooks) that the host's own git then executes, so orchestrator secrets must not be in it. */
export function runnerGitEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return withoutOrchEnv(base) as Record<string, string>;
}

export function runnerGit(baseDir?: string): SimpleGit {
  const env = runnerGitEnv();
  const unsafe: Partial<Record<UnsafeFlag, boolean>> = {};
  for (const key of Object.keys(env)) {
    const flag = UNSAFE_ENV_FLAGS[key.toUpperCase()];
    if (flag) unsafe[flag] = true;
  }
  return simpleGit({ ...(baseDir ? { baseDir } : {}), unsafe }).env(env);
}
