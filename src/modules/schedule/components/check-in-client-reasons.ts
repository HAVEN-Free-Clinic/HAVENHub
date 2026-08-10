/**
 * Failure reasons the client can detect before ever contacting the server: the
 * Geolocation API failed before a fix was obtained (permission denied, no fix,
 * or timed out). check-in-panel.tsx reports one of these to
 * check-in/page.tsx's `reportClientFailure` server action purely so PostHog
 * sees the full failure funnel, including the outcomes that never reach
 * checkInSelf. Reporting is analytics-only: nothing here can create an
 * attendance row or influence a verdict, which stays entirely server-owned
 * (see attendance.ts).
 *
 * Deliberately NOT in check-in-panel.tsx, which is "use client": a Server
 * Component that imports a plain value (not a type) from a "use client"
 * module gets a client-reference proxy, not the real array/function, so
 * `isClientDetectedFailureReason` would silently stop working the moment
 * something tried to call it server-side. Living here, undecorated, lets both
 * sides import the real thing -- the client component for the type, the
 * server action for the type guard.
 */
export type ClientDetectedFailureReason = "PERMISSION_DENIED" | "POSITION_UNAVAILABLE" | "TIMEOUT";

const REASONS: ReadonlySet<string> = new Set<ClientDetectedFailureReason>([
  "PERMISSION_DENIED",
  "POSITION_UNAVAILABLE",
  "TIMEOUT",
]);

/**
 * Type guard for a reason reported by the client. Treat the input as
 * untrusted: a server action must validate against this exact set and drop
 * anything else rather than forwarding an arbitrary caller-supplied string to
 * an analytics event verbatim.
 */
export function isClientDetectedFailureReason(value: string): value is ClientDetectedFailureReason {
  return REASONS.has(value);
}
