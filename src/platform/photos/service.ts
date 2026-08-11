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
 */
async function storePhoto(
  personId: string,
  bytes: Buffer,
  source: "yalies" | "upload"
): Promise<void> {
  const key = photoKeyFor(personId);
  await putObject(key, bytes, PHOTO_CONTENT_TYPE);
  try {
    await prisma.person.update({
      where: { id: personId },
      data: {
        photoKey: key,
        photoSource: source,
        photoVersion: { increment: 1 },
        photoUpdatedAt: new Date(),
        photoSyncMisses: 0,
        // An upload is an affirmative choice to have a photo, so it clears a
        // prior "do not use my Yale photo". A Yalies pull cannot reach here
        // while suppressed, so writing false is a no-op on that path.
        photoSuppressed: false,
      },
    });
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

  const fetched = await fetchYaliesPhoto(person.netId as string);
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

  await storePhoto(personId, normalized, "yalies");
  await prisma.person.update({ where: { id: personId }, data: { photoSyncedAt: now } });
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
  if (file.size > maxMb * 1024 * 1024) {
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
 */
export async function removePhoto(personId: string): Promise<void> {
  const person = await prisma.person.findUnique({
    where: { id: personId },
    select: { photoKey: true, photoSource: true },
  });
  if (!person) return;

  if (person.photoKey) await deleteObject(person.photoKey).catch(() => undefined);

  await prisma.person.update({
    where: { id: personId },
    data: {
      photoKey: null,
      photoSource: null,
      photoVersion: { increment: 1 },
      photoUpdatedAt: new Date(),
      photoSuppressed: person.photoSource === "yalies",
    },
  });
}
