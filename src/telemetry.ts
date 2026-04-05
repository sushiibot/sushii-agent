import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

export const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
});

sdk.start();

const endpoint =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
  "http://localhost:4318";
console.log(`OTel traces → ${endpoint}`);
