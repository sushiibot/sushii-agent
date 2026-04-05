import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base";
import { envDetector } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { trace } from "@opentelemetry/api";

// BasicTracerProvider doesn't auto-read OTEL_* env vars — detect them explicitly.
// envDetector reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES.
const resource = await envDetector.detect();

const exporter = new OTLPTraceExporter({
  compression: CompressionAlgorithm.NONE,
});

const provider = new BasicTracerProvider({
  resource,
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
console.log(`OTel traces → ${endpoint} (service: ${resource.attributes[ATTR_SERVICE_NAME]})`);
