import { getPostHogClient } from "@/platform/posthog/posthog-server";

/**
 * Server-side PostHog event capture for HAVEN Hub.
 *
 * Wraps `getPostHogClient()` so call sites stop repeating the
 * get-client / capture / flush dance, and so every event flows through one
 * place that (a) drops `undefined` properties, (b) attaches group analytics,
 * and (c) flushes before a serverless function can freeze (the node client runs
 * `flushAt: 1`, so capture already queues the send; the awaited flush guarantees
 * the request finishes before the function is frozen).
 *
 * Server-only (posthog-node). Safe to import from `@/modules` services: the
 * banned boundary direction is `@/platform` importing `@/modules`, not this.
 * Best-effort by nature; callers should not depend on delivery.
 */

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

function cleanProperties(
  properties?: EventProperties,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
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

/** Capture one server-side event. Flushes unless `flush: false`. */
export async function captureEvent(input: CaptureEventInput): Promise<void> {
  const client = getPostHogClient();
  const properties: Record<string, unknown> = cleanProperties(input.properties);
  if (input.setPersonProperties) properties.$set = input.setPersonProperties;
  client.capture({
    distinctId: input.distinctId,
    event: input.event,
    properties,
    groups: cleanGroups(input.groups),
  });
  if (input.flush !== false) await client.flush();
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
  const client = getPostHogClient();
  client.alias({ distinctId: input.personId, alias: input.previousDistinctId });
  if (input.flush !== false) await client.flush();
}

/** Force-flush queued events. Use after a batch captured with `flush: false`. */
export async function flushEvents(): Promise<void> {
  await getPostHogClient().flush();
}
