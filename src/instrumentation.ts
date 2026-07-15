import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";

/**
 * PostHog Logs are ingested over OpenTelemetry (OTLP). We reuse the same
 * project token and host the rest of the PostHog SDK already uses so there is
 * a single place to configure the destination.
 *
 * The provider is created at module scope (not inside `register()`) so route
 * handlers, server actions, and crons can import it to flush logs before a
 * serverless function freezes. See `@/platform/logging`.
 *
 * A `SimpleLogRecordProcessor` exports each record as soon as it is emitted,
 * mirroring the app's existing `posthog-node` config (`flushAt: 1`). Combined
 * with the console mirror in the logging helper, that keeps delivery reliable
 * without wrapping every call site in a manual flush.
 */
const POSTHOG_TOKEN = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const POSTHOG_HOST = (
  process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com"
).replace(/\/+$/, "");

// Only ship logs from the Node.js runtime (and plain scripts). The edge runtime
// cannot use the node OTLP transport, and there is no reason to emit from it.
const shouldExport =
  Boolean(POSTHOG_TOKEN) && process.env.NEXT_RUNTIME !== "edge";

export const loggerProvider = new LoggerProvider({
  resource: resourceFromAttributes({
    "service.name": "havenhub",
    ...(process.env.VERCEL_ENV
      ? { "deployment.environment.name": process.env.VERCEL_ENV }
      : {}),
  }),
  processors: shouldExport
    ? [
        new SimpleLogRecordProcessor({
          exporter: new OTLPLogExporter({
            url: `${POSTHOG_HOST}/i/v1/logs`,
            headers: {
              Authorization: `Bearer ${POSTHOG_TOKEN}`,
              "Content-Type": "application/json",
            },
          }),
        }),
      ]
    : [],
});

export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    logs.setGlobalLoggerProvider(loggerProvider);
  }
}
