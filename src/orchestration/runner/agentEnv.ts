// Env vars the agent's shell keeps from the runner process. Everything else (App key, OpenRouter
// key, orchestrator URLs, SSH_AUTH_SOCK) is dropped so an agent running `env` can't echo secrets
// into tool output, transcripts or PRs. Not a sandbox: the agent can still read /proc/1/environ.
const ALLOWED = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TZ", "HOSTNAME", "PWD"]);
// PI_*: session metadata Pi itself sets; AGENT_BROWSER_*: image-level browser config.
const ALLOWED_PREFIXES = ["LC_", "PI_", "AGENT_BROWSER_"];
// ORCH_SECRET / ORCH_RUNNER_SECRET let a holder register with the orchestrator; no agent gets them.
const ORCH_PREFIX = "ORCH_";

export function buildAgentEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (ALLOWED.has(key) || ALLOWED_PREFIXES.some((p) => key.startsWith(p))) env[key] = value;
  }
  return withoutOrchEnv({ ...env, ...extra });
}

/** Copy of `env` minus every ORCH_* var, for agents that otherwise inherit the runner's full env. */
export function withoutOrchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !key.startsWith(ORCH_PREFIX)) out[key] = value;
  }
  return out;
}
