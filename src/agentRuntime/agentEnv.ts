// Env vars the agent's shell keeps from the host process. Everything else (OpenRouter key,
// orchestrator URLs, SSH_AUTH_SOCK) is dropped so an agent running `env` can't echo secrets
// into tool output, transcripts or PRs. Not a sandbox: the agent can still read /proc/1/environ.
const ALLOWED = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TZ", "HOSTNAME", "PWD"]);
// PI_*: session metadata Pi itself sets; AGENT_BROWSER_*: image-level browser config.
const ALLOWED_PREFIXES = ["LC_", "PI_", "AGENT_BROWSER_"];
// ORCH_SECRET lets a holder register as the workspace with the bot; no agent gets it.
const ORCH_PREFIX = "ORCH_";

export interface AgentEnvOptions {
  /** Prefixes dropped even when allowlisted, e.g. PI_ for the workspace, whose PI_CODING_AGENT_DIR points at auth.json. */
  dropPrefixes?: readonly string[];
}

export function buildAgentEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}, options: AgentEnvOptions = {}): NodeJS.ProcessEnv {
  const drop = options.dropPrefixes ?? [];
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries({ ...base, ...extra })) {
    if (value === undefined || drop.some((p) => key.startsWith(p))) continue;
    if (key in extra || ALLOWED.has(key) || ALLOWED_PREFIXES.some((p) => key.startsWith(p))) env[key] = value;
  }
  return withoutOrchEnv(env);
}

/** Copy of `env` minus every ORCH_* var, for processes that otherwise inherit the host's full env. */
export function withoutOrchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !key.startsWith(ORCH_PREFIX)) out[key] = value;
  }
  return out;
}
