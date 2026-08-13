/**
 * PostHog events for member photos.
 *
 * The Yalies pull is the only third-party integration in this codebase and the
 * only one whose failure is invisible: a miss degrades to initials, which looks
 * exactly like "this person has no photo", and the escalating 1 / 7 / 30 day
 * backoff in policy.ts makes a broken integration get QUIETER over time rather
 * than louder. Until these events existed the sole report was a `log.warn` in
 * yalies.ts, so a renamed field or a revoked key would have shown up as nothing
 * at all in PostHog. One event per outcome turns that into a rate to alert on.
 *
 * Kept out of service.ts so the event names and property shapes read in one
 * place, and so the service keeps reading as storage logic.
 *
 * PRIVACY: never send a netId, a photo URL, or a filename. yalies.ts is
 * deliberate about keeping netIds out of logs (see its header) and the same
 * rule holds here. Only the fixed miss vocabulary travels.
 *
 * No group is attached. `activeTermGroup()` costs a term lookup per event and
 * these fire on an image request path; nothing about a photo is term-scoped,
 * and the point of the events is integration health, not semester funnels.
 */
import { captureEvent } from "@/platform/posthog/capture";
import type { YaliesMiss } from "./yalies";

/**
 * How a Yalies pull ended.
 *
 * One event with an outcome property rather than an event per branch, so a
 * single trend broken down by `outcome` shows the health of the integration and
 * an alert can watch one series instead of correlating five.
 */
export type PhotoPullOutcome =
  /** Bytes fetched, normalized, and stored. */
  | "sourced"
  /** Yalies had no usable photo for this netId, or the call itself failed. */
  | "missed"
  /** Yalies returned bytes sharp could not decode. */
  | "unreadable"
  /** Object storage or the row write threw. Ours, not theirs. */
  | "store_failed"
  /** The member uploaded or opted out mid-fetch, so the write was refused. */
  | "superseded";

/**
 * Record the outcome of one Yalies pull attempt.
 *
 * Fires only when Yalies was actually called -- not when policy declined the
 * attempt (backoff, suppression, no netId) and not when the feature is inert
 * for want of an API key. That keeps the denominator meaningful: every event is
 * one real round trip, so `missed / total` is the integration's error rate
 * rather than a number diluted by every avatar render in the app.
 *
 * `person_specific` is the discriminator that matters when reading a spike.
 * False means the failure says nothing about this member (API down, contract
 * drift, timeout) and is therefore equally true of everyone right now -- that
 * is the shape of an outage. True means the netId matched nobody or that person
 * has no Face Book photo, which is the expected steady state for most of the
 * roster and should not page anyone. See yalies.ts's PERSON_SPECIFIC_MISSES.
 */
export async function capturePhotoPull(input: {
  personId: string;
  outcome: PhotoPullOutcome;
  /** The reason from yalies.ts. Set only when `outcome` is "missed". */
  reason?: YaliesMiss;
  /** Whether this failure advanced the person's own backoff. */
  personSpecific?: boolean;
  /** Consecutive person-specific misses BEFORE this attempt, so the backoff
   *  step a failure is landing on is visible without a join. */
  priorMisses: number;
}): Promise<void> {
  await captureEvent({
    event: "member_photo_pull_attempted",
    distinctId: input.personId,
    properties: {
      outcome: input.outcome,
      reason: input.reason,
      person_specific: input.personSpecific,
      prior_misses: input.priorMisses,
    },
  });
}

/**
 * Record a stored photo upload.
 *
 * `by_self` separates a member setting their own photo from an admin setting
 * one for them, which is the same distinction that decides whether the upload
 * clears a prior opt-out (see setPhotoFromUpload).
 */
export async function capturePhotoUploaded(input: {
  personId: string;
  bySelf: boolean;
  /** Size of the stored WebP, after normalization -- not the original file. */
  bytes: number;
  /** Content type the member actually submitted, before re-encoding. */
  contentType: string;
}): Promise<void> {
  await captureEvent({
    event: "member_photo_uploaded",
    distinctId: input.personId,
    properties: {
      by_self: input.bySelf,
      bytes: input.bytes,
      content_type: input.contentType,
    },
  });
}

/**
 * Record a removed photo.
 *
 * `suppressed` is the opt-out signal: removing a Yalies-sourced photo means "do
 * not use my Yale photo" and blocks all future pulls, while removing an upload
 * leaves backfill open. Counting the two separately is the only way to see how
 * often auto-sourcing is being rejected, which is the question that decides
 * whether applying Yalies photos without asking first is still defensible.
 */
export async function capturePhotoRemoved(input: {
  personId: string;
  previousSource: string | null;
  suppressed: boolean;
}): Promise<void> {
  await captureEvent({
    event: "member_photo_removed",
    distinctId: input.personId,
    properties: {
      previous_source: input.previousSource,
      suppressed: input.suppressed,
    },
  });
}
