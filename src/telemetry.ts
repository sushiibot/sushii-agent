import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base";
import { trace } from "@opentelemetry/api";

const exporter = new OTLPTraceExporter({
  compression: CompressionAlgorithm.NONE,
});

const provider = new BasicTracerProvider({
  spanProcessors: [new BatchSpanProcessor(exporter)],
});
trace.setGlobalTracerProvider(provider);

export const sdk = {
  shutdown: () => provider.shutdown(),
};

const endpoint =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
  "http://localhost:4318";
console.log(`OTel traces → ${endpoint} (provider: ${trace.getTracerProvider().constructor.name})`);
