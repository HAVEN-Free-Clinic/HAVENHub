import { errorAttrs, flushLogs, log } from "@/platform/logging";

/**
 * Dev-only smoke test for PostHog Logs. Hit `GET /api/_health/log-test` while
 * running locally to emit one record at each severity and confirm they land in
 * PostHog (Activity -> Logs). Returns 404 in production so it is not exposed.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (process.env.NODE_ENV === "production") {
    return new Response("Not found", { status: 404 });
  }

  const at = new Date().toISOString();

  log.debug("[log-test] debug record", { at });
  log.info("[log-test] info record", { at, source: "log-test-route" });
  log.warn("[log-test] warn record", { at });
  log.error(
    "[log-test] error record",
    errorAttrs(new Error("synthetic error for log-test"), { at }),
  );

  await flushLogs();

  return Response.json({ ok: true, emitted: ["debug", "info", "warn", "error"], at });
}
