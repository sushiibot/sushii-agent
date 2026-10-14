// Bun.spawn without `env` passes a startup snapshot of the full environment, secrets included.
const ALLOWED = ["PATH", "HOME", "USER", "LANG", "TZ", "TMPDIR"];
const ALLOWED_PREFIXES = ["LC_"];

/** Allowlisted env for a child process, plus `extra` (which wins). Pass it as `env` on every spawn. */
export function childEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (ALLOWED.includes(key) || ALLOWED_PREFIXES.some((p) => key.startsWith(p))) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Env for git: the allowlist plus the ssh-agent socket the entrypoint loads the push key into. */
export function gitEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const sock = base["SSH_AUTH_SOCK"];
  return childEnv({ ...(sock ? { SSH_AUTH_SOCK: sock } : {}), ...extra }, base);
}
