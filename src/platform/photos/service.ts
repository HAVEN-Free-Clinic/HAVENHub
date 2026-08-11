/**
 * Member profile photo state, and the only writer of Person's photo columns.
 *
 * Photos come from two places. Yale College students are auto-sourced from the
 * Yalies API on first view; everyone else uploads their own. Removing an
 * auto-sourced photo suppresses further pulls, which is what makes opt-out real,
 * given that Yalies photos are applied without asking first.
 */
import { prisma } from "@/platform/db";
import { deleteObject, getObject, putObject } from "@/platform/storage";
import { normalizePhoto } from "./normalize";
import { PHOTO_CONTENT_TYPE, PhotoError } from "./shared";
import { shouldAttemptYaliesPull, type PhotoState } from "./policy";
import { fetchYaliesPhoto, isYaliesEnabled } from "./yalies";

/** Upload types we accept. Everything is re-encoded to WebP regardless. */
export const ACCEPTED_UPLOAD_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export type ResolvedPhoto = { bytes: Buffer; contentType: string } | null;

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
 * - "upload" is an explicit, synchronous member or admin action. It always
 *   wins: the write is unconditional, including clearing photoSuppressed,
 *   because choosing to upload a photo is an affirmative override of any
 *   prior "do not use my Yale photo".
 * - "yalies" is a background pull that holds pre-write state across a
 *   network fetch plus normalize, easily a couple of seconds. An
 *   unconditional write here could land after the member clicked Remove
 *   during that window, silently reverting their opt-out with no error. So
 *   the row write is a conditional claim, via updateMany with a where clause
 *   requiring photoSuppressed still be false: if a suppression landed in the
 *   meantime, zero rows match, and this deletes the bytes it just wrote and
 *   reports failure so the caller falls back to initials instead of quietly
 *   overwriting the member's choice.
 *
 * `syncedAt`, when given, is folded into this same write rather than left to
 * a separate update afterward, so a successful Yalies pull is exactly one
 * database write on the success path. Bytes are already durable in object
 * storage by the time this runs; a second write failing after that must
 * never turn an otherwise-successful resolution into a thrown error.
 *
 * Returns false only when a Yalies write lost the suppression race above;
 * true in every other case.
 */
async function storePhoto(
  personId: string,
  bytes: Buffer,
  source: "yalies" | "upload",
  syncedAt?: Date
): Promise<boolean> {
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
        data: { ...data, photoSuppressed: false },
      });
      return true;
    }

    const result = await prisma.person.updateMany({
      where: { id: personId, photoSuppressed: false },
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
 */
export async function resolvePhoto(personId: string, now: Date = new Date()): Promise<ResolvedPhoto> {
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

  const fetched = await fetchYaliesPhoto(person.netId);
  if (!fetched) {
    await prisma.person.update({
      where: { id: personId },
      data: { photoSyncedAt: now, photoSyncMisses: { increment: 1 } },
    });
    return null;
  }

  let normalized: Buffer;
  try {
    normalized = await normalizePhoto(fetched);
  } catch {
    // Yalies handed us bytes sharp cannot read. Their problem, our miss.
    await prisma.person.update({
      where: { id: personId },
      data: { photoSyncedAt: now, photoSyncMisses: { increment: 1 } },
    });
    return null;
  }

  const stored = await storePhoto(personId, normalized, "yalies", now);
  if (!stored) {
    // Lost the race against a concurrent opt-out: someone suppressed this
    // person between the Yalies fetch and this write. The bytes were already
    // deleted inside storePhoto. Fall back to initials rather than serving a
    // photo the member just asked not to have.
    return null;
  }
  return { bytes: normalized, contentType: PHOTO_CONTENT_TYPE };
}

/** Validate, normalize, and store a member- or admin-supplied photo. */
export async function setPhotoFromUpload(
  personId: string,
  file: { type: string; size: number; bytes: Buffer },
  maxMb: number
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
  await storePhoto(personId, await normalizePhoto(file.bytes), "upload");
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
 *   by an upload, and only by an upload.
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
