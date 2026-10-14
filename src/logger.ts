import { trace } from "@opentelemetry/api";
import pino, { type LoggerOptions } from "pino";
import { knownSecretValues } from "./secrets.ts";

const URL_TOKENS = /(\/(?:webhooks|interactions)\/\d+\/)[^/?\s"]+|([?&](?:key|token|api_key|access_token)=)[^&\s"]+|(Bearer\s+)[^\s"]+/gi;

export function scrubUrl(s: string): string {
  return s.replace(URL_TOKENS, (_m, path, query, bearer) => `${path ?? query ?? bearer}REDACTED`);
}

export function scrubSecrets(s: string, known: readonly string[] = knownSecretValues()): string {
  return known.reduce((acc, v) => acc.split(v).join("[REDACTED]"), scrubUrl(s));
}

function serializeErr(err: unknown): unknown {
  const serialized = pino.stdSerializers.err(err as Error);
  const json = JSON.stringify(serialized);
  return json === undefined ? serialized : JSON.parse(scrubSecrets(json));
}

// `*` matches exactly one level, so top-level and nested keys are listed separately.
export const loggerOptions: LoggerOptions = {
  redact: {
    paths: [
      "authorization",
      "token",
      "apiKey",
      "*.authorization",
      "*.Authorization",
      "*.headers.authorization",
      "*.headers.Authorization",
      "*.token",
      "*.apiKey",
      "*.privateKey",
      "*.clientSecret",
      "err.requestBody",
      "err.config.headers.authorization",
      "err.config.headers.Authorization",
    ],
    censor: "[REDACTED]",
  },
  serializers: { err: serializeErr },
};

const logger = pino({
  ...loggerOptions,
  level: "debug",
  mixin() {
    const spanContext = trace.getActiveSpan()?.spanContext();
    if (!spanContext?.traceId) {
      return {};
    }
    return {
      trace_id: spanContext.traceId,
      span_id: spanContext.spanId,
      trace_flags: spanContext.traceFlags,
    };
  },
});

export function initLogger(level: string) {
  logger.level = level;
}

export function getLogger(module: string) {
  return logger.child({ module });
}

export default logger;
