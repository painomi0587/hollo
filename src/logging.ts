import { AsyncLocalStorage } from "node:async_hooks";
import { Writable } from "node:stream";

import { getFileSink } from "@logtape/file";
import {
  configure,
  getAnsiColorFormatter,
  getLogger,
  getStreamSink,
  jsonLinesFormatter,
  logfmtFormatter,
  type LogLevel,
  type LogRecord,
  parseLogLevel,
} from "@logtape/logtape";

import { federation } from "./federation/federation";

// oxlint-disable-next-line typescript/dot-notation
const LOG_LEVEL: LogLevel = parseLogLevel(process.env["LOG_LEVEL"] ?? "info");
// oxlint-disable-next-line typescript/dot-notation
const LOG_QUERY: boolean = process.env["LOG_QUERY"] === "true";
// oxlint-disable-next-line typescript/dot-notation
const LOG_FILE: string | undefined = process.env["LOG_FILE"];
// oxlint-disable-next-line typescript/dot-notation
const LOG_FILE_FORMAT = process.env["LOG_FILE_FORMAT"] ?? "jsonl";
const fileFormatter =
  LOG_FILE_FORMAT === "logfmt" ? logfmtFormatter : jsonLinesFormatter;

await configure({
  contextLocalStorage: new AsyncLocalStorage(),
  sinks: {
    console: getStreamSink(Writable.toWeb(process.stderr) as WritableStream, {
      formatter: getAnsiColorFormatter({
        timestamp: "time",
      }),
    }),
    file:
      LOG_FILE == null
        ? () => undefined
        : getFileSink(LOG_FILE, {
            formatter: fileFormatter,
          }),
    debugger: federation.sink ?? ((_: LogRecord) => {}),
  },
  filters: {},
  loggers: [
    { category: [], sinks: ["debugger"] },
    {
      category: "fedify",
      lowestLevel: LOG_LEVEL,
      sinks: ["console", "file"],
    },
    {
      category: "hollo",
      lowestLevel: LOG_LEVEL,
      sinks: ["console", "file"],
    },
    {
      category: "drizzle-orm",
      lowestLevel: LOG_QUERY ? "debug" : "fatal",
      sinks: ["console", "file"],
    },
    {
      category: ["logtape", "meta"],
      lowestLevel: "warning",
      sinks: ["console", "file"],
    },
    {
      // Dedicated category for the `LOG_QUERY` startup warning so it
      // is emitted regardless of the operator's chosen `LOG_LEVEL`.
      // `parentSinks: "override"` prevents the parent `hollo` logger
      // from duplicating each record into the same console/file sinks.
      category: ["hollo", "logging"],
      lowestLevel: "warning",
      sinks: ["console", "file"],
      parentSinks: "override",
    },
  ],
});

// `LOG_QUERY=true` causes drizzle-orm to emit every SQL query with its
// bound parameter values.  Those parameters routinely include OAuth
// access tokens (stored plain in the DB), authorization codes, signed
// session-cookie material, and other secrets.  Anyone with read access
// to the resulting logs (or to a downstream collector such as Sentry,
// Loki, or a file sink) can replay them.  Make sure operators see a
// loud warning at every startup so the flag is not left on by accident
// in production.
if (LOG_QUERY) {
  getLogger(["hollo", "logging"]).warning(
    "LOG_QUERY=true is set: drizzle-orm will log every SQL query " +
      "together with its bound parameter values.  Those parameters " +
      "include OAuth access tokens, authorization codes, and other " +
      "secrets.  Use this only for local debugging; never leave it " +
      "enabled in production.",
  );
}
