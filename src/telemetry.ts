import * as traceloop from "@traceloop/node-server-sdk";
import { OTLPTraceExporter as OTLPTraceExporterHttp } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as OTLPTraceExporterGrpc } from "@opentelemetry/exporter-trace-otlp-grpc";

const protocol = process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf";
const exporter =
  protocol === "grpc"
    ? new OTLPTraceExporterGrpc()
    : new OTLPTraceExporterHttp();

traceloop.initialize({
  appName: "sushii-agent",
  disableBatch: process.env.NODE_ENV !== "production",
  exporter,
});
