import { createFederationDebugger } from "@fedify/debugger";
import {
  createFederation,
  type Federation,
  ParallelMessageQueue,
} from "@fedify/fedify";
import { FedifySpanExporter } from "@fedify/fedify/otel";
import { PostgresKvStore, PostgresMessageQueue } from "@fedify/postgres";
import type { Sink } from "@logtape/logtape";
import { context, propagation, type TracerProvider } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import metadata from "../../package.json" with { type: "json" };
import { postgres } from "../db";

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
const nodeType = process.env["NODE_TYPE"] ?? "all";

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
const fedifyDebug = process.env["FEDIFY_DEBUG"] === "true";

const kv = new PostgresKvStore(postgres);

let exporter: FedifySpanExporter | undefined;
let tracerProvider: TracerProvider | undefined;
if (fedifyDebug) {
  // Register context manager and propagator (required for trace
  // propagation across async boundaries and message queues):
  context.setGlobalContextManager(new AsyncLocalStorageContextManager());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  exporter = new FedifySpanExporter(kv);
  tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
}

let federation: Federation<void> & { sink?: Sink } = createFederation<void>({
  kv,
  queue: new ParallelMessageQueue(new PostgresMessageQueue(postgres), 10),
  // Only start the queue automatically if not running as a web-only node
  manuallyStartQueue: nodeType === "web",
  userAgent: {
    software: `Hollo/${metadata.version}`,
  },
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  allowPrivateAddress: process.env["ALLOW_PRIVATE_ADDRESS"] === "true",
  tracerProvider,
});

if (fedifyDebug && exporter != null) {
  federation = createFederationDebugger(federation, { exporter, kv });
}

export { federation };
export default federation;
