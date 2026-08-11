/**
 * Member profile photo state, and the only writer of Person's photo columns.
 *
 * Photos come from two places. Yale College students are auto-sourced from the
 * Yalies API on first view; everyone else uploads their own. Removing an
 * auto-sourced photo suppresses further pulls, which is what makes opt-out real,
 * given that Yalies photos are applied without asking first.
 */
import { prisma } from "@/platform/db";
import { log, errorAttrs } from "@/platform/logging";
import { deleteObject, getObject, putObject } from "@/platform/storage";
import { getSetting } from "@/platform/settings/service";
import { normalizePhoto } from "./normalize";
import { PHOTO_CONTENT_TYPE, PhotoError } from "./shared";
import { shouldAttemptYaliesPull, type PhotoState } from "./policy";
import { fetchYaliesPhoto, isPersonSpecificMiss, isYaliesEnabled } from "./yalies";

/** Upload types we accept. Everything is re-encoded to WebP regardless. */
export const ACCEPTED_UPLOAD_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export type ResolvedPhoto = { bytes: Buffer; contentType: string } | null;

/**
 * Stamp a failed pull, advancing the person's backoff only when the failure was
 * actually about them.
 *
 * `photoSyncMisses` drives an escalating 1 / 7 / 30 day backoff, so what counts
 * toward it matters. A person-specific miss (nobody matched that netId, or they
 * have no Face Book photo) is a durable fact and should back off hard: those
 * people are most of the roster and would otherwise be re-queried forever.
 *
 * An integration failure is not a fact about the person. Counting it means a
 * single bad deploy silences everyone it touched for a day or more after the
 * problem is fixed. The timestamp is still written, so a broken integration
 * cannot be re-hit on every avatar render, but the counter stays put and the
 * wait is the short transient cooldown instead.
 */
async function recordMiss(personId: string, now: Date, personSpecific: boolean): Promise<void> {
  await prisma.person.update({
    where: { id: personId },
    data: {
      photoSyncedAt: now,
      ...(personSpecific ? { photoSyncMisses: { increment: 1 } } : {}),
    },
  });
}

/** Object storage key for a person's photo. Fixed, so a new photo overwrites. */
function photoKeyFor(personId: string): string {
  return `people/${personId}`;
}

/**
 * Write bytes, then the row. If the row write fails, drop the bytes.
 *
 * Order matters and is the same one platform/branding/assets.ts uses. Writing
 * the row first would point photoKey at an object that may never arrive, and
 * the route would then serve a 404 for a person the database says has a photo.
 *
 * The two sources write the row differently, because they carry different
 * risk:
 *
 * - "upload" is an explicit, synchronous member or admin action. The bytes
 *   and provenance write unconditionally either way, but whether the write
 *   also clears photoSuppressed depends on WHO is uploading, via the
 *   `clearSuppression` option: it should be true only when the actor is the
 *   target person themselves, because only then is the upload that person's
 *   own affirmative override of a prior "do not use my Yale photo". An admin
 *   uploading a photo FOR someone else is not that -- it says nothing about
 *   whether the member still wants their Yale photo pulled if this upload is
 *   later removed, so it must leave an existing suppression exactly as it
 *   was. See setPhotoFromUpload, the only caller, for how that boolean is
 *   computed from the acting person's id.
 * - "yalies" is a background pull that holds pre-write state across a
 *   network fetch plus normalize, easily a couple of seconds. An
 *   unconditional write here could land after the member clicked Remove, or
 *   uploaded their own photo, during that window -- either silently
 *   reverting their opt-out, or silently replacing their chosen upload with
 *   the Yale photo, with no error either way. So the row write is a
 *   conditional claim, via updateMany with a where clause requiring BOTH
 *   photoSuppressed still be false AND photoKey still be null: if a
 *   suppression landed, or any photo (upload or a previous Yalies pull)
 *   landed, in the meantime, zero rows match, and this deletes the bytes it
 *   just wrote and reports failure so the caller falls back to initials
 *   instead of quietly overwriting the member's choice.
 *
 * `syncedAt`, when given, is folded into this same write rather than left to
 * a separate update afterward, so a successful Yalies pull is exactly one
 * database write on the success path. Bytes are already durable in object
 * storage by the time this runs; a second write failing after that must
 * never turn an otherwise-successful resolution into a thrown error.
 *
 * Returns false only when a Yalies write lost the race above; true in every
 * other case.
 */
async function storePhoto(
  personId: string,
  bytes: Buffer,
  source: "yalies" | "upload",
  options: { syncedAt?: Date; clearSuppression?: boolean } = {}
): Promise<boolean> {
  const { syncedAt, clearSuppression = false } = options;
  const key = photoKeyFor(personId);
  await putObject(key, bytes, PHOTO_CONTENT_TYPE);

  const data = {
    photoKey: key,
    photoSource: source,
    photoVersion: { increment: 1 },
    photoUpdatedAt: new Date(),
    photoSyncMisses: 0,
    ...(syncedAt ? { photoSyncedAt: syncedAt } : {}),
  };

  try {
    if (source === "upload") {
      await prisma.person.update({
        where: { id: personId },
        data: clearSuppression ? { ...data, photoSuppressed: false } : data,
      });
      return true;
    }

    const result = await prisma.person.updateMany({
      where: { id: personId, photoSuppressed: false, photoKey: null },
      data,
    });
    if (result.count === 0) {
      await deleteObject(key).catch(() => undefined);
      return false;
    }
    return true;
  } catch (err) {
    await deleteObject(key).catch(() => undefined);
    throw err;
  }
}

/**
 * The subset of Person that resolvePhoto reads and threads through repair and
 * policy. Matches PhotoState plus the id needed to re-fetch bytes and write
 * repairs back.
 */
type PersonPhotoRow = PhotoState & { id: string };

/**
 * Clear a row's photoKey/photoSource and bump photoVersion, WITHOUT touching
 * photoSuppressed, and return the repaired in-memory state so the caller can
 * evaluate policy against it in the same request.
 *
 * This runs when photoKey points at an object that getObject could not find:
 * the row and object storage have gone out of sync (a failed delete, a manual
 * bucket operation, storage backend migration, and so on). It is a storage
 * repair, not a member choosing to remove their photo, so it must never set
 * photoSuppressed -- doing so would silently opt someone out of photos because
 * of an infrastructure failure rather than their own choice.
 *
 * Consequence worth flagging: if the bytes that went missing were a
 * self-uploaded photo, the repaired state has no photo and is not suppressed,
 * so a Yalies photo may backfill it below. That is consistent with this
 * design's rule that removing an uploaded photo does not suppress Yalies (see
 * removePhoto), but it is subtle enough to call out here: an upload can be
 * silently replaced by a Yalies photo purely because its bytes were lost, with
 * no action from the member.
 *
 * The version bump matters even though there is no new photo yet: it busts any
 * cached URL (browser cache, CDN) still pointing at the now-dead object, so a
 * stale cache does not keep serving (or keep 404ing on) bytes that no longer
 * exist.
 */
async function repairTornRow(person: PersonPhotoRow): Promise<PersonPhotoRow> {
  await prisma.person.update({
    where: { id: person.id },
    data: {
      photoKey: null,
      photoSource: null,
      photoVersion: { increment: 1 },
      photoUpdatedAt: new Date(),
    },
  });
  return { ...person, photoKey: null };
}

/**
 * The person's photo bytes, fetching from Yalies on a miss when policy allows.
 *
 * Returns null when there is no photo, which callers render as initials. Never
 * throws on a Yalies failure: every one of those is recorded as a miss.
 *
 * `allowPull` additionally gates whether a Yalies fetch may happen at all,
 * independent of the backoff policy below. Defaults to FALSE, not true: this
 * is an amplification guard, so the safe direction on an omitted option is
 * deny, not allow. A future caller that forgets the option gets the inert
 * behavior (stored-or-null, never a third-party fetch) instead of silently
 * reopening the 25-way outbound burst this option exists to close. The
 * in-app photo route is the only production caller today and always passes
 * it explicitly: `allowPull: true` for a self-view, `allowPull: false`
 * whenever the requesting person is not the target person, because an admin
 * viewing someone else's photo must only ever see what is already stored,
 * never trigger an outbound call to a third party on that person's behalf.
 * A stored photo is still served regardless of this flag; only the
 * fetch-on-miss path is gated.
 */
export async function resolvePhoto(
  personId: string,
  now: Date = new Date(),
  options: { allowPull?: boolean } = {}
): Promise<ResolvedPhoto> {
  const { allowPull = false } = options;
  let person = await prisma.person.findUnique({
    where: { id: personId },
    select: {
      id: true,
      netId: true,
      yaleAffiliation: true,
      photoKey: true,
      photoSuppressed: true,
      photoSyncedAt: true,
      photoSyncMisses: true,
    },
  });
  if (!person) return null;

  if (person.photoKey) {
    const bytes = await getObject(person.photoKey);
    if (bytes) return { bytes, contentType: PHOTO_CONTENT_TYPE };
    // The row points at bytes that are gone: a torn row. Repair it and keep
    // going with the repaired state so policy below sees photoKey: null
    // rather than refusing a Yalies pull on a photo that no longer exists.
    person = await repairTornRow(person);
  }

  // Bounds outbound Yalies traffic to self-driven views (see the doc comment
  // above and the in-app route's own comment): checked before the backoff
  // policy so a cross-view can never trigger a pull regardless of how stale
  // photoSyncedAt is.
  if (!allowPull) return null;

  if (!shouldAttemptYaliesPull(person, now)) return null;

  // Without an API key the feature is inert. Check before attempting rather than
  // letting fetchYaliesPhoto return null, which would be recorded as a miss:
  // that would churn photoSyncedAt and photoSyncMisses on every view in local
  // dev and CI, where no key is configured. policy.ts stays free of config
  // dependencies, so the check lives here rather than in the predicate.
  if (!isYaliesEnabled()) return null;

  // shouldAttemptYaliesPull already requires a netId (see policy.ts), but
  // that guarantee lives behind a function boundary the type checker cannot
  // see through. Checking again here removes the need for a cast on the call
  // below: if that predicate is ever reordered or loses its netId check,
  // this fails closed (no pull) instead of silently posting a null netId to
  // Yalies, matching nobody, and starting a permanent miss stream with no
  // type error and no test failure to catch it.
  if (!person.netId) return null;

  // Bounds the Yalies image download the same way uploads.maxMb bounds a
  // member's own upload (see yalies.ts's fetchYaliesPhoto, which enforces
  // this against the response); resolved here rather than hardcoded in
  // yalies.ts, which has no settings dependency of its own on purpose.
  const maxMb = await getSetting<number>("uploads.maxMb");
  const fetched = await fetchYaliesPhoto(person.netId, maxMb * 1024 * 1024);
  if ("miss" in fetched) {
    await recordMiss(personId, now, isPersonSpecificMiss(fetched.miss));
    return null;
  }

  let normalized: Buffer;
  try {
    normalized = await normalizePhoto(fetched.bytes);
  } catch {
    // Yalies handed us bytes sharp cannot read. That is a fact about their
    // object, not about this person, so it does not advance the person's
    // backoff any more than an API outage would.
    await recordMiss(personId, now, false);
    return null;
  }

  // A storage failure is an integration failure, not a fact about this person,
  // so it is recorded the same way an API outage is: stamp the timestamp for a
  // short cooldown, leave the miss counter alone.
  //
  // Without this the pull is unbounded while storage is down. Nothing gets
  // written, so nothing gates the next attempt, and every single view re-runs
  // the whole Yalies round trip only to fail at the same place. That is the
  // amplification the backoff exists to prevent, aimed at a third party with no
  // published rate limit, and it is exactly what happened in preview when R2 was
  // unset and the disk driver tried to mkdir on a read-only filesystem.
  let stored: boolean;
  try {
    stored = await storePhoto(personId, normalized, "yalies", { syncedAt: now });
  } catch (err) {
    log.warn("[photos] storing a Yalies photo failed", errorAttrs(err));
    await recordMiss(personId, now, false);
    return null;
  }
  if (!stored) {
    // Lost the race above: a concurrent opt-out (photoSuppressed flipped to
    // true) or a concurrent photo of either source (photoKey no longer null)
    // landed between the Yalies fetch and this write. The bytes were already
    // deleted inside storePhoto. Fall back to initials rather than serving a
    // photo the member just asked not to have, or clobbering the photo they
    // just chose themselves.
    return null;
  }
  return { bytes: normalized, contentType: PHOTO_CONTENT_TYPE };
}

/**
 * Validate, normalize, and store a member- or admin-supplied photo.
 *
 * `actorId` is who is performing the upload, which may differ from
 * `personId` when an admin uploads on someone else's behalf. Suppression is
 * cleared only when they match -- an admin uploading FOR someone else must
 * never silently undo that person's own opt-out. See storePhoto's doc
 * comment for the full reasoning.
 */
export async function setPhotoFromUpload(
  personId: string,
  file: { type: string; size: number; bytes: Buffer },
  maxMb: number,
  actorId: string
): Promise<void> {
  if (!ACCEPTED_UPLOAD_TYPES.has(file.type)) {
    throw new PhotoError(`Unsupported image type "${file.type}". Use PNG, JPEG, or WebP.`);
  }
  // file.size is caller-declared metadata, not a fact about file.bytes. Judge
  // the larger of the two so a lied-about size cannot slip past the sole
  // validation boundary before bytes reach normalizePhoto.
  if (Math.max(file.size, file.bytes.length) > maxMb * 1024 * 1024) {
    throw new PhotoError(`Image too large; the limit is ${maxMb} MB.`);
  }
  await storePhoto(personId, await normalizePhoto(file.bytes), "upload", {
    clearSuppression: actorId === personId,
  });
}

/**
 * Clear the person's photo.
 *
 * Removing a Yalies-sourced photo sets photoSuppressed, meaning "do not use my
 * Yale photo". Removing a self-uploaded one does not: deleting your own upload
 * says nothing about the Yale photo, so backfill may refill it.
 *
 * Two things make that promise hold even under a repeated or overlapping
 * call, both required together:
 *
 * - Nothing to remove is a no-op. Without the early return below, a second
 *   removePhoto for the same person (a double-clicked button, a retried form
 *   post, an admin removing a photo someone already removed) would run the
 *   update again with photoSource now null, which is never "yalies" -- so an
 *   absolute write here would silently flip a real suppression back to
 *   false, undoing the member's opt-out for no reason at all.
 * - The row only ever writes photoSuppressed: true, never false. When the
 *   source being removed is not "yalies", the field is omitted from the
 *   update entirely (Prisma treats an omitted key as "do not write"), which
 *   leaves an existing suppression exactly as it was. "Leaves it untouched"
 *   has to mean literally untouched, not "writes back the value it probably
 *   already had" -- the schema's own comment promises suppression is cleared
 *   only by the target person's own upload, never by this function.
 */
export async function removePhoto(personId: string): Promise<void> {
  const person = await prisma.person.findUnique({
    where: { id: personId },
    select: { photoKey: true, photoSource: true },
  });
  if (!person) return;
  if (!person.photoKey) return;

  // Row first, object second: deliberately the opposite of storePhoto's
  // bytes-then-row order, because a removal has the opposite failure risk.
  // storePhoto must never point the row at bytes that might not arrive. A
  // crash between deleting the object and writing the row here would leave
  // photoKey pointing at now-missing bytes with photoSuppressed never
  // recorded; the next resolvePhoto would then run its torn-row repair,
  // which is (correctly) suppression-neutral, and the member's removal of a
  // Yale photo would silently become "no photo, not suppressed" -- exactly
  // the state a Yalies pull is allowed to backfill. Writing the row first
  // means suppression is durably recorded even if the process dies before
  // the delete runs; the orphaned object at that key is unreachable (nothing
  // points at it any more) and gets overwritten by the next putObject at the
  // same key regardless. Do not reorder this to match storePhoto "for
  // consistency" -- the two functions have opposite risks on purpose.
  const key = person.photoKey;
  await prisma.person.update({
    where: { id: personId },
    data: {
      photoKey: null,
      photoSource: null,
      photoVersion: { increment: 1 },
      photoUpdatedAt: new Date(),
      ...(person.photoSource === "yalies" ? { photoSuppressed: true } : {}),
    },
  });
  await deleteObject(key).catch(() => undefined);
}
