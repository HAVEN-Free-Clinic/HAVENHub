import { getPostHogClient } from "@/platform/posthog/posthog-server";
import { log } from "@/platform/logging";

/**
 * Server-side PostHog event capture for HAVEN Hub.
 *
 * Wraps `getPostHogClient()` so call sites stop repeating the
 * get-client / capture / flush dance, and so every event flows through one
 * place that (a) drops `undefined` properties, (b) attaches group analytics,
 * and (c) flushes best-effort.
 *
 * BEST-EFFORT CONTRACT (enforced, not just documented): capture is awaited on the
 * request path at ~30 call sites, many right after a committed DB write. A slow or
 * unreachable PostHog must never fail that action or add its ~49s retry budget to
 * the latency. So the flush is bounded by a short timeout AND every path swallows
 * errors -- callers must not depend on delivery. Losing an event during a PostHog
 * outage is acceptable; breaking a user's action because analytics is down is not.
 *
 * Server-only (posthog-node). Safe to import from `@/modules` services: the
 * banned boundary direction is `@/platform` importing `@/modules`, not this.
 */

/** Max time to block a request on a PostHog flush before letting it finish in the
 *  background. posthog-node otherwise retries with ~10s timeouts (~49s worst case). */
const FLUSH_TIMEOUT_MS = 3000;

/** Flush queued events without ever throwing or blocking longer than the timeout. */
async function boundedFlush(client: { flush: () => Promise<unknown> }): Promise<void> {
  const flushed = Promise.resolve(client.flush())
    .then(() => undefined)
    .catch((err) => {
      log.warn("[posthog] event flush failed (best-effort)", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  await Promise.race([
    flushed,
    new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
  ]);
}

/** PostHog group types. Registered implicitly the first time an event carries one. */
export const GROUP_TERM = "term";
export const GROUP_DEPARTMENT = "department";

export type EventGroups = Partial<
  Record<typeof GROUP_TERM | typeof GROUP_DEPARTMENT, string>
>;

/** Event property values PostHog can index. `undefined` keys are dropped. */
export type EventProperties = Record<
  string,
  string | number | boolean | null | undefined
>;

/** Person-profile properties set via `$set`. */
export type PersonProperties = Record<
  string,
  string | number | boolean | string[] | null
>;

export interface CaptureEventInput {
  event: string;
  distinctId: string;
  properties?: EventProperties;
  groups?: EventGroups;
  /** Merged into `properties.$set` to update the person profile. */
  setPersonProperties?: PersonProperties;
  /**
   * Flush immediately (default). Pass `false` inside a loop or batch, then call
   * `flushEvents()` once after the loop to avoid a flush per iteration.
   */
  flush?: boolean;
}

/**
 * Which deployment produced this event.
 *
 * Production, staging, preview and local dev all write into ONE PostHog project
 * (docs/DEPLOY.md has staging deliberately reusing production's PostHog vars),
 * and staging runs a fork of the production database. Client events are already
 * separable by `$host`, and server LOGS carry `deployment.environment.name` on
 * the OTLP resource -- but server EVENTS carried nothing, so a staging or local
 * run was indistinguishable from production in product analytics (audit 14,
 * OBS-05).
 *
 * VERCEL_ENV is "production" | "preview" | "development" on Vercel and unset
 * elsewhere, which is exactly the distinction wanted here.
 */
const ENVIRONMENT = process.env.VERCEL_ENV ?? "development";

function cleanProperties(
  properties?: EventProperties,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = { environment: ENVIRONMENT };
  if (!properties) return out;
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function cleanGroups(groups?: EventGroups): Record<string, string> | undefined {
  if (!groups) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(groups)) {
    if (value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Capture one server-side event. Flushes (bounded, best-effort) unless `flush: false`.
 *  Never throws -- analytics must not fail a committed user action. */
export async function captureEvent(input: CaptureEventInput): Promise<void> {
  try {
    const client = getPostHogClient();
    const properties: Record<string, unknown> = cleanProperties(input.properties);
    if (input.setPersonProperties) properties.$set = input.setPersonProperties;
    client.capture({
      distinctId: input.distinctId,
      event: input.event,
      properties,
      groups: cleanGroups(input.groups),
    });
    if (input.flush !== false) await boundedFlush(client);
  } catch (err) {
    log.warn("[posthog] captureEvent failed (best-effort)", {
      event: input.event,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Merge a previous distinct id (e.g. an applicant email) into a person's
 * canonical id so pre-conversion events join the person timeline. Flushes
 * unless `flush: false`.
 */
export async function aliasPerson(input: {
  personId: string;
  previousDistinctId: string;
  flush?: boolean;
}): Promise<void> {
  try {
    const client = getPostHogClient();
    client.alias({ distinctId: input.personId, alias: input.previousDistinctId });
    if (input.flush !== false) await boundedFlush(client);
  } catch (err) {
    log.warn("[posthog] aliasPerson failed (best-effort)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Force-flush queued events. Use after a batch captured with `flush: false`.
 *  Bounded + best-effort: never throws or blocks longer than the flush timeout. */
export async function flushEvents(): Promise<void> {
  await boundedFlush(getPostHogClient());
}
