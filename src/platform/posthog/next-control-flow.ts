/**
 * Recognise Next.js control-flow sentinels so they can be kept out of Error
 * Tracking.
 *
 * Next.js implements `redirect()` and `notFound()` by *throwing* sentinel
 * errors rather than returning: `redirect()` throws an `Error` whose message is
 * `"NEXT_REDIRECT"` and whose `digest` is `"NEXT_REDIRECT;<type>;<url>;…"`, and
 * `notFound()` throws one carrying `"NEXT_NOT_FOUND"`. This is intended control
 * flow (see `src/platform/actions.ts` and
 * `src/app/(app)/incidents/actions.ts`), not a crash, so it must never be
 * reported as an exception, where it would otherwise be a recurring source of
 * false-positive noise across every redirect-heavy flow.
 *
 * These helpers back the two paths that would otherwise capture them: the
 * error-boundary reporter (`capture-exception.tsx`) and posthog-js's global
 * exception handler via `before_send` (`instrumentation-client.ts`).
 */

const NEXT_CONTROL_FLOW_SENTINELS = ["NEXT_REDIRECT", "NEXT_NOT_FOUND"] as const;

function matchesSentinel(text: unknown): boolean {
  return (
    typeof text === "string" &&
    NEXT_CONTROL_FLOW_SENTINELS.some((sentinel) => text.startsWith(sentinel))
  );
}

/**
 * True when an error's `digest` marks it as a Next.js `redirect()`/`notFound()`
 * sentinel. Used in the error boundaries, which receive the error object.
 */
export function isNextControlFlowError(error: { digest?: unknown }): boolean {
  return matchesSentinel(error?.digest);
}

/**
 * True when a posthog-js capture event is an `$exception` whose captured errors
 * are all Next.js control-flow sentinels. Used as the drop condition in the
 * `before_send` filter, where only the serialised event (not the original
 * error) is available: the sentinel surfaces as the exception `value`.
 */
export function isNextControlFlowEvent(
  event: {
    event?: string;
    properties?: { $exception_list?: Array<{ value?: unknown }> };
  } | null,
): boolean {
  if (!event || event.event !== "$exception") return false;
  const list = event.properties?.$exception_list;
  return (
    Array.isArray(list) &&
    list.length > 0 &&
    list.every((entry) => matchesSentinel(entry?.value))
  );
}
