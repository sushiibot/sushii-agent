// Env vars the agent's shell keeps from the runner process. Everything else (App key, OpenRouter
// key, orchestrator URLs, SSH_AUTH_SOCK) is dropped so an agent running `env` can't echo secrets
// into tool output, transcripts or PRs. Not a sandbox: the agent can still read /proc/1/environ.
const ALLOWED = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TZ", "HOSTNAME", "PWD"]);
const ALLOWED_PREFIXES = ["LC_"];

export function buildAgentEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (ALLOWED.has(key) || ALLOWED_PREFIXES.some((p) => key.startsWith(p))) env[key] = value;
  }
  return { ...env, ...extra };
}
