import { SeverityNumber } from "@opentelemetry/api-logs";

import { loggerProvider } from "@/instrumentation";

/**
 * Server-side structured logging for HAVEN Hub.
 *
 * Every call does two things:
 *   1. Mirrors to `console` so local dev output and Vercel's native runtime
 *      logs keep working exactly as before.
 *   2. Emits an OpenTelemetry log record to PostHog Logs with structured
 *      attributes you can search and filter on.
 *
 * Prefer this over raw `console.*` in server code (route handlers, server
 * actions, crons, and the platform/modules services they call). It is safe to
 * import from `tsx` scripts too; logs are best-effort and never throw.
 *
 * Client components cannot use this (OTLP is node-only); keep `console` there.
 */

const otelLogger = loggerProvider.getLogger("havenhub");

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Attribute values PostHog Logs can index. `undefined` keys are dropped. */
export type LogAttributes = Record<
  string,
  string | number | boolean | null | undefined
>;

const SEVERITY_NUMBER: Record<LogLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

// info mirrors to console.log (not console.info) to preserve the exact stdout
// behaviour of the console.log calls this logger replaced.
const CONSOLE_METHOD: Record<LogLevel, "debug" | "log" | "warn" | "error"> = {
  debug: "debug",
  info: "log",
  warn: "warn",
  error: "error",
};

function clean(attributes?: LogAttributes): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!attributes) return out;
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function emit(level: LogLevel, message: string, attributes?: LogAttributes): void {
  const attrs = clean(attributes);
  const hasAttrs = Object.keys(attrs).length > 0;

  // 1. Console mirror: preserves existing local + Vercel logging behaviour.
  if (hasAttrs) {
    console[CONSOLE_METHOD[level]](message, attrs);
  } else {
    console[CONSOLE_METHOD[level]](message);
  }

  // 2. Ship to PostHog Logs (best-effort; must never throw on the request path).
  try {
    otelLogger.emit({
      body: message,
      severityNumber: SEVERITY_NUMBER[level],
      severityText: level.toUpperCase(),
      attributes: attrs,
    });
  } catch {
    // Swallow: logging must not break the operation being logged.
  }
}

export const log = {
  debug: (message: string, attributes?: LogAttributes) => emit("debug", message, attributes),
  info: (message: string, attributes?: LogAttributes) => emit("info", message, attributes),
  warn: (message: string, attributes?: LogAttributes) => emit("warn", message, attributes),
  error: (message: string, attributes?: LogAttributes) => emit("error", message, attributes),
};

/**
 * Turn an unknown caught value into structured, loggable attributes.
 * Use at `catch` sites: `log.error("...", errorAttrs(err, { id }))`.
 */
export function errorAttrs(error: unknown, extra?: LogAttributes): LogAttributes {
  const base: LogAttributes = { ...extra };
  if (error instanceof Error) {
    base["error.type"] = error.name;
    base["error.message"] = error.message;
    if (error.stack) base["error.stack"] = error.stack;
  } else if (error !== undefined && error !== null) {
    base["error.message"] = String(error);
  }
  return base;
}

/**
 * Force-flush pending log records. Call at the end of a route handler or cron
 * (ideally via `next/server`'s `after()`) when you need delivery guaranteed
 * before the serverless function freezes. Best-effort, never throws.
 */
export async function flushLogs(): Promise<void> {
  try {
    await loggerProvider.forceFlush();
  } catch {
    // best-effort
  }
}
