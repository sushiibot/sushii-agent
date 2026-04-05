// Quick OTel export test — run with:
//   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4999 bun test-otel.ts
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base";
import { trace, SpanStatusCode } from "@opentelemetry/api";

const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? "http://localhost:4999";
console.log(`Exporting to: ${endpoint}/v1/traces`);

const exporter = new OTLPTraceExporter({
  url: `${endpoint}/v1/traces`,
  compression: CompressionAlgorithm.NONE,
});

const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
trace.setGlobalTracerProvider(provider);

console.log(`Provider: ${trace.getTracerProvider().constructor.name}`);

const tracer = trace.getTracer("sushii-agent-test");
const span = tracer.startSpan("test.span", {
  attributes: { "test.key": "hello from bun", runtime: "bun" },
});
console.log(`Span class: ${span.constructor.name}`);
span.setStatus({ code: SpanStatusCode.OK });
span.end();

console.log("Span ended, waiting for export...");
await new Promise((r) => setTimeout(r, 2000));
await provider.shutdown();
console.log("Done.");
