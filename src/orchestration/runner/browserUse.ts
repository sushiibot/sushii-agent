import { getLogger } from "../../logger.ts";

const log = getLogger("orchestration.runner.browserUse");
const API = "https://api.browser-use.com/api/v4/browsers";

interface SessionSummary {
  id: string;
  metadata?: Record<string, string> | null;
}

/**
 * Stop this runner's Browser Use sessions whose task isn't in `keepTaskIds`. Sessions are tagged
 * runner=<id> task=<taskId> at creation (agent-browser-web), so this finds leftovers from a crash,
 * a deploy restart, or an interrupted create — anything the per-task close never reached.
 */
export async function sweepBrowserUse(opts: { apiKey: string; runnerId: string; keepTaskIds?: Set<string> }): Promise<number> {
  const headers = { "X-Browser-Use-API-Key": opts.apiKey, "Content-Type": "application/json" };
  const url = `${API}?filterBy=active&pageSize=100&metadata=${encodeURIComponent(`runner=${opts.runnerId}`)}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`list sessions failed: ${res.status}`);
  const body = (await res.json()) as { items?: SessionSummary[] };
  const stale = (body.items ?? []).filter((s) => !opts.keepTaskIds?.has(s.metadata?.task ?? ""));
  await Promise.all(
    stale.map((s) =>
      fetch(`${API}/${s.id}`, { method: "PATCH", headers, body: JSON.stringify({ action: "stop" }) }).catch((err) =>
        log.warn({ err, sessionId: s.id }, "failed to stop Browser Use session"),
      ),
    ),
  );
  return stale.length;
}
