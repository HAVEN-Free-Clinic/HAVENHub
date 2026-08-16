/**
 * Server-side error reporting into PostHog Error Tracking.
 *
 * Wired into Next.js via the `onRequestError` export re-exported from
 * `src/instrumentation.ts`. Next calls it for every server-side error (RSC,
 * route handlers, server actions). Client exceptions are already captured by
 * `capture_exceptions: true` in `instrumentation-client.ts`; this closes the
 * server-side half so the `error_tracking` signals see the whole picture.
 *
 * The posthog-node client is imported lazily inside the node guard so the edge
 * runtime bundle never pulls in a node-only module.
 */

import { scrubPath } from "@/platform/posthog/scrub-url";

/**
 * Pull the visitor's distinct id out of the posthog-js cookie
 * (`ph_<token>_posthog`), so a server error attributes to the same person as
 * their client events. Returns undefined when absent or unparseable.
 */
export function distinctIdFromCookie(
  cookieHeader?: string | null,
): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(/ph_phc_.*?_posthog=([^;]+)/);
  if (!match) return undefined;
  try {
    const data = JSON.parse(decodeURIComponent(match[1])) as {
      distinct_id?: unknown;
    };
    return typeof data.distinct_id === "string" ? data.distinct_id : undefined;
  } catch {
    return undefined;
  }
}

type RequestErrorRequest = {
  path?: string;
  method?: string;
  headers?: Record<string, string | undefined>;
};

type RequestErrorContext = {
  routerKind?: string;
  routePath?: string;
  routeType?: string;
};

export async function onRequestError(
  error: unknown,
  request: RequestErrorRequest,
  context: RequestErrorContext,
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { getPostHogClient } = await import(
      "@/platform/posthog/posthog-server"
    );
    const client = getPostHogClient();
    client.captureException(error, distinctIdFromCookie(request.headers?.cookie), {
      // Same redaction as the client hook: an error thrown while rendering
      // /onboard/<token> or /login/verify?token=... must not carry the credential.
      path: request.path ? scrubPath(request.path) : request.path,
      method: request.method,
      router_kind: context.routerKind,
      route_path: context.routePath,
      route_type: context.routeType,
      // Staging, preview and local dev share this PostHog project with
      // production, so a server exception with no path context was previously
      // unattributable (audit 14, OBS-05).
      environment: process.env.VERCEL_ENV ?? "development",
    });
    await client.flush();
  } catch {
    // Error reporting must never throw on the error path.
  }
}
