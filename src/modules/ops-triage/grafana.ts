import { config } from "../../config.ts";

const REPO_TO_CONTAINER: Record<string, string> = {
  "sushii-bot": "sushii_bot",
  "sushii-agent": "sushii_agent",
  "sushii-sns": "sushii_sns",
  "sushii-leveling-bot": "sushii_leveling_lisa",
  "sushii-modmail": "sushii_modmail_lisa",
};

interface LokiQueryResult {
  data: {
    result: { stream: Record<string, string>; values: [string, string][] }[];
  };
}

export interface LogSearchParams {
  service?: string;
  /** Free-text substring filter, applied as a LogQL line filter (case-sensitive). */
  query?: string;
  startMs: number;
  endMs: number;
}

/** Queries Loki for log lines matching the given service/text filter over an explicit [startMs, endMs) range. */
export async function queryLoki({ service, query, startMs, endMs }: LogSearchParams): Promise<string> {
  if (!config.grafanaBaseUrl) throw new Error("GRAFANA_BASE_URL is not configured.");

  const container = service ? (REPO_TO_CONTAINER[service] ?? service) : undefined;
  const streamSelector = container ? `{container="${container}"}` : `{container=~".+"}`;
  const selector = query ? `${streamSelector} |= ${JSON.stringify(query)}` : streamSelector;
  const startNs = BigInt(startMs) * 1_000_000n;
  const endNs = BigInt(endMs) * 1_000_000n;

  const url = new URL("/loki/api/v1/query_range", config.grafanaBaseUrl);
  url.searchParams.set("query", selector);
  url.searchParams.set("start", startNs.toString());
  url.searchParams.set("end", endNs.toString());
  url.searchParams.set("limit", "200");

  const res = await fetch(url, {
    headers: config.grafanaApiToken ? { Authorization: `Bearer ${config.grafanaApiToken}` } : {},
  });
  if (!res.ok) throw new Error(`Loki query failed: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as LokiQueryResult;
  const lines = body.data.result.flatMap((stream) => stream.values.map(([ts, line]) => `[${new Date(Number(ts) / 1_000_000).toISOString()}] ${line}`));
  lines.sort();

  if (lines.length === 0) return `No log lines found for ${container ?? "any service"} between ${new Date(startMs).toISOString()} and ${new Date(endMs).toISOString()}${query ? ` matching "${query}"` : ""}.`;
  return lines.slice(0, 100).join("\n");
}

/** OTel tracing is currently only wired up for sushii-agent (see project telemetry docs) — other services will just come back empty here. */
const TEMPO_SERVICE_NAME: Record<string, string> = {
  "sushii-agent": "sushii-agent",
};

interface TempoSearchResult {
  traces?: {
    traceID: string;
    rootServiceName?: string;
    rootTraceName?: string;
    startTimeUnixNano?: string;
    durationMs?: number;
  }[];
}

/**
 * Searches Tempo via TraceQL for traces from `service` over an explicit [startMs, endMs) range.
 * NOTE: assumes Tempo's query API is reachable directly at tempoBaseUrl/grafanaBaseUrl —
 * if this LGTM deployment instead requires going through Grafana's datasource-proxy path
 * (/api/datasources/proxy/uid/<uid>/api/search), this needs updating to that shape.
 */
export async function queryTempo(service: string | undefined, startMs: number, endMs: number): Promise<string | undefined> {
  const base = config.tempoBaseUrl ?? config.grafanaBaseUrl;
  if (!base) throw new Error("TEMPO_BASE_URL or GRAFANA_BASE_URL is not configured.");

  const serviceName = service ? TEMPO_SERVICE_NAME[service] : undefined;
  if (service && !serviceName) return undefined; // no tracing for this service — don't bother querying

  const traceql = serviceName ? `{resource.service.name="${serviceName}"}` : `{}`;
  const startSec = Math.floor(startMs / 1000);
  const endSec = Math.ceil(endMs / 1000);

  const url = new URL("/api/search", base);
  url.searchParams.set("q", traceql);
  url.searchParams.set("start", startSec.toString());
  url.searchParams.set("end", endSec.toString());
  url.searchParams.set("limit", "20");

  const res = await fetch(url, {
    headers: config.grafanaApiToken ? { Authorization: `Bearer ${config.grafanaApiToken}` } : {},
  });
  if (!res.ok) throw new Error(`Tempo search failed: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as TempoSearchResult;
  const traces = body.traces ?? [];
  if (traces.length === 0) return `No traces found for ${serviceName ?? "any service"} between ${new Date(startMs).toISOString()} and ${new Date(endMs).toISOString()}.`;

  return traces
    .map((t) => {
      const start = t.startTimeUnixNano ? new Date(Number(BigInt(t.startTimeUnixNano) / 1_000_000n)).toISOString() : "?";
      return `trace:${t.traceID} [${start}] ${t.rootServiceName ?? "?"} ${t.rootTraceName ?? ""} (${t.durationMs ?? "?"}ms)`;
    })
    .join("\n");
}
