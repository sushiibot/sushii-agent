import { config } from "../../config.ts";

/**
 * Loki and Tempo aren't reachable directly from sushii-agent's deploy host — Loki has no
 * exposed port at all (Grafana reaches it over localhost inside the same LGTM container),
 * and Tempo's port is bound Tailscale-only. Grafana itself is the one thing with a routable
 * address (grafana.infra.sushii.bot, gated by Tailscale but reachable that way), so every
 * query goes through its datasource-proxy API instead of hitting Loki/Tempo ports directly.
 */
function datasourceProxyUrl(datasourceUid: string, path: string): URL {
  if (!config.grafanaBaseUrl) throw new Error("GRAFANA_BASE_URL is not configured.");
  return new URL(`/api/datasources/proxy/uid/${datasourceUid}${path}`, config.grafanaBaseUrl);
}

function grafanaHeaders(extra?: Record<string, string>): Record<string, string> {
  return { ...(config.grafanaApiToken ? { Authorization: `Bearer ${config.grafanaApiToken}` } : {}), ...extra };
}

const REPO_TO_CONTAINER: Record<string, string> = {
  "sushii-bot": "sushii_bot",
  "sushii-agent": "sushii_agent",
  "sushii-sns": "sushii_sns",
  "sushii-leveling-bot": "sushii_leveling_lisa",
  "sushii-modmail": "sushii_modmail_lisa",
};

interface LokiStreamEntry {
  stream: Record<string, string>;
  values: [string, string][];
}
interface LokiMatrixEntry {
  metric: Record<string, string>;
  values: [number, string][];
}
interface LokiVectorEntry {
  metric: Record<string, string>;
  value: [number, string];
}
interface LokiQueryResult {
  data: {
    resultType?: "streams" | "matrix" | "vector" | string;
    result: (LokiStreamEntry | LokiMatrixEntry | LokiVectorEntry)[];
  };
}

export interface LogSearchParams {
  service?: string;
  /** Free-text substring filter, applied as a LogQL line filter (case-sensitive). Ignored when `logql` is set. */
  query?: string;
  /** Raw LogQL used VERBATIM as the query, bypassing the container selector — the model's escape
   *  hatch for chained filters (`|= A |= B`), `!=`, `| json`, and rate/aggregation expressions. */
  logql?: string;
  startMs: number;
  endMs: number;
}

function labelSet(metric: Record<string, string>): string {
  const entries = Object.entries(metric);
  if (entries.length === 0) return "{}";
  return `{${entries.map(([k, v]) => `${k}="${v}"`).join(", ")}}`;
}

/** Queries Loki (via Grafana's datasource-proxy) over an explicit [startMs, endMs) range. Formats
 *  log-stream results as timestamped lines; matrix/vector results (from an aggregating `logql`) as
 *  a label-set plus its value(s), rather than mis-formatting numbers as log lines. */
export async function queryLoki({ service, query, logql, startMs, endMs }: LogSearchParams): Promise<string> {
  const container = service ? (REPO_TO_CONTAINER[service] ?? service) : undefined;
  let selector: string;
  if (logql) {
    selector = logql;
  } else {
    const streamSelector = container ? `{container="${container}"}` : `{container=~".+"}`;
    selector = query ? `${streamSelector} |= ${JSON.stringify(query)}` : streamSelector;
  }
  const startNs = BigInt(startMs) * 1_000_000n;
  const endNs = BigInt(endMs) * 1_000_000n;

  const url = datasourceProxyUrl("loki", "/loki/api/v1/query_range");
  url.searchParams.set("query", selector);
  url.searchParams.set("start", startNs.toString());
  url.searchParams.set("end", endNs.toString());
  url.searchParams.set("limit", "200");

  const res = await fetch(url, { headers: grafanaHeaders() });
  if (!res.ok) throw new Error(`Loki query failed: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as LokiQueryResult;
  const scope = logql ? `\`${logql}\`` : (container ?? "any service");
  const window = `between ${new Date(startMs).toISOString()} and ${new Date(endMs).toISOString()}`;

  // An aggregating query (rate/count_over_time/sum by …) returns matrix/vector, where each entry is
  // a metric label-set + numeric sample(s) — NOT a log stream. Format it as such.
  if (body.data.resultType === "matrix" || body.data.resultType === "vector") {
    const rows = body.data.result.flatMap((entry) => {
      const e = entry as LokiMatrixEntry | LokiVectorEntry;
      const label = labelSet(e.metric);
      if ("value" in e) return [`${label} = ${e.value[1]}`];
      return e.values.map(([ts, v]) => `[${new Date(ts * 1000).toISOString()}] ${label} = ${v}`);
    });
    if (rows.length === 0) return `No results for ${scope} ${window}.`;
    return rows.slice(0, 100).join("\n");
  }

  const streams = body.data.result as LokiStreamEntry[];
  const lines = streams.flatMap((s) => s.values.map(([ts, line]) => `[${new Date(Number(ts) / 1_000_000).toISOString()}] ${line}`));
  lines.sort();

  if (lines.length === 0) return `No log lines found for ${scope} ${window}${!logql && query ? ` matching "${query}"` : ""}.`;
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

/** Searches Tempo (via Grafana's datasource-proxy) via TraceQL for traces from `service` over an explicit [startMs, endMs) range. */
export async function queryTempo(service: string | undefined, startMs: number, endMs: number): Promise<string | undefined> {
  const serviceName = service ? TEMPO_SERVICE_NAME[service] : undefined;
  if (service && !serviceName) return undefined; // no tracing for this service — don't bother querying

  const traceql = serviceName ? `{resource.service.name="${serviceName}"}` : `{}`;
  const startSec = Math.floor(startMs / 1000);
  const endSec = Math.ceil(endMs / 1000);

  const url = datasourceProxyUrl("tempo", "/api/search");
  url.searchParams.set("q", traceql);
  url.searchParams.set("start", startSec.toString());
  url.searchParams.set("end", endSec.toString());
  url.searchParams.set("limit", "20");

  const res = await fetch(url, { headers: grafanaHeaders() });
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

interface OtlpAttributeValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: OtlpAttributeValue[] };
}

interface OtlpAttribute {
  key: string;
  value?: OtlpAttributeValue;
}

interface OtlpEvent {
  name: string;
  timeUnixNano?: string;
  attributes?: OtlpAttribute[];
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpAttribute[];
  status?: { code?: number; message?: string };
  events?: OtlpEvent[];
}

interface OtlpTrace {
  resourceSpans?: {
    resource?: { attributes?: OtlpAttribute[] };
    scopeSpans?: { spans?: OtlpSpan[] }[];
  }[];
}

function formatAttrValue(v: OtlpAttributeValue | undefined): string {
  if (!v) return "";
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return v.intValue;
  if (v.doubleValue !== undefined) return String(v.doubleValue);
  if (v.boolValue !== undefined) return String(v.boolValue);
  if (v.arrayValue) return `[${(v.arrayValue.values ?? []).map(formatAttrValue).join(", ")}]`;
  return "";
}

function formatAttrs(attrs: OtlpAttribute[] | undefined): string {
  if (!attrs?.length) return "";
  return attrs.map((a) => `${a.key}=${formatAttrValue(a.value)}`).join(" ");
}

// OTel status codes: 0 = unset, 1 = ok, 2 = error.
const STATUS_ERROR = 2;

/**
 * Fetches a single trace by ID (via Grafana's datasource-proxy) and flattens its span tree into
 * plain text — depth-indented, ordered depth-first by start time, with duration/attributes/error
 * status/events per span.
 */
export async function getTraceById(traceId: string): Promise<string> {
  const url = datasourceProxyUrl("tempo", `/api/traces/${traceId}`);
  const res = await fetch(url, { headers: grafanaHeaders({ Accept: "application/json" }) });
  if (res.status === 404) return `No trace found with ID ${traceId}.`;
  if (!res.ok) throw new Error(`Tempo trace lookup failed: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as OtlpTrace;
  const spans = (body.resourceSpans ?? []).flatMap((rs) =>
    (rs.scopeSpans ?? []).flatMap((ss) => (ss.spans ?? []).map((span) => ({ span, resourceAttrs: rs.resource?.attributes }))),
  );
  if (spans.length === 0) return `No trace found with ID ${traceId}.`;

  const spanIds = new Set(spans.map((e) => e.span.spanId));
  const byParent = new Map<string, typeof spans>();
  for (const entry of spans) {
    // A parentSpanId that isn't among this trace's own spans (remote parent, cross-service
    // root) is treated as a root too, rather than silently dropping the span.
    const key = entry.span.parentSpanId && spanIds.has(entry.span.parentSpanId) ? entry.span.parentSpanId : "";
    byParent.set(key, [...(byParent.get(key) ?? []), entry]);
  }

  const lines: string[] = [];
  const render = (parentId: string, depth: number) => {
    const children = (byParent.get(parentId) ?? []).sort((a, b) => Number(BigInt(a.span.startTimeUnixNano) - BigInt(b.span.startTimeUnixNano)));
    for (const { span } of children) {
      const durationMs = Number((BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000n);
      const indent = "  ".repeat(depth);
      const statusFlag = span.status?.code === STATUS_ERROR ? " [ERROR]" : "";
      const statusMsg = span.status?.message ? ` "${span.status.message}"` : "";
      lines.push(`${indent}${span.name} (${durationMs}ms)${statusFlag}${statusMsg}`);
      const attrs = formatAttrs(span.attributes);
      if (attrs) lines.push(`${indent}  ${attrs}`);
      for (const event of span.events ?? []) {
        lines.push(`${indent}  event: ${event.name} ${formatAttrs(event.attributes)}`.trimEnd());
      }
      render(span.spanId, depth + 1);
    }
  };
  render("", 0);

  return lines.join("\n");
}
