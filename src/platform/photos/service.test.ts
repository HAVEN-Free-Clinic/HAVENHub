import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { deleteObject, getObject } from "@/platform/storage";
import { PhotoError } from "./shared";
import { removePhoto, resolvePhoto, setPhotoFromUpload } from "./service";

vi.mock("./yalies", async (importOriginal) => {
  // isPersonSpecificMiss stays REAL: it is the classifier under test in the
  // backoff cases below, and mocking it would make those assertions vacuous.
  const actual = await importOriginal<typeof import("./yalies")>();
  return {
    ...actual,
    isYaliesEnabled: vi.fn(() => true),
    fetchYaliesPhoto: vi.fn(async () => ({ miss: "no_image" }) as const),
  };
});

import { fetchYaliesPhoto, isYaliesEnabled } from "./yalies";

/** Real PNG bytes, so normalizePhoto has something it can actually decode. */
async function pngBytes(): Promise<Buffer> {
  return sharp({
    create: { width: 800, height: 800, channels: 3, background: { r: 5, g: 5, b: 5 } },
  })
    .png()
    .toBuffer();
}

async function seedPerson(overrides: Record<string, unknown> = {}) {
  return prisma.person.create({
    data: { name: "Ada Lovelace", netId: "abc12", yaleAffiliation: "yale_college", ...overrides },
  });
}

describe("resolvePhoto", () => {
  beforeEach(async () => {
    await resetDb();
    // mockReturnValue survives clearAllMocks, so re-arm both every test.
    vi.mocked(isYaliesEnabled).mockReturnValue(true);
    vi.mocked(fetchYaliesPhoto).mockResolvedValue({ miss: "no_image" });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("stores and returns a photo when Yalies has one", async () => {
    vi.mocked(fetchYaliesPhoto).mockResolvedValue({ bytes: await pngBytes() });
    // Seeded away from the defaults (misses: 0, syncedAt: null) so the
    // photoSyncMisses-resets-to-0 assertion below is load-bearing: a fresh
    // person already reads 0, so it can't tell "reset" from "never touched".
    // The old syncedAt clears the backoff window so the pull still fires.
    const person = await seedPerson({
      photoSyncMisses: 2,
      photoSyncedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    });

    const resolved = await resolvePhoto(person.id, new Date(), { allowPull: true });

    expect(resolved?.contentType).toBe("image/webp");
    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoKey).toBe(`people/${person.id}`);
    expect(after.photoSource).toBe("yalies");
    expect(after.photoVersion).toBe(1);
    expect(after.photoSyncMisses).toBe(0);
    expect(await getObject(`people/${person.id}`)).not.toBeNull();
  });

  it("records a miss and returns null when Yalies has nothing", async () => {
    const person = await seedPerson();

    expect(await resolvePhoto(person.id, new Date(), { allowPull: true })).toBeNull();

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoKey).toBeNull();
    expect(after.photoSyncMisses).toBe(1);
    expect(after.photoSyncedAt).not.toBeNull();
  });

  it("does not advance the person's backoff when the integration itself failed", async () => {
    // The bug this guards, seen in production: the upstream image host moved, so
    // every Yale College member took one bad_host miss. That incremented their
    // counter into a one-day backoff, and the fix deployed within the hour still
    // could not reach any of them until the next day. An integration failure is
    // not a fact about a person and must not spend their retry budget.
    vi.mocked(fetchYaliesPhoto).mockResolvedValue({ miss: "bad_host" });
    const person = await seedPerson();

    expect(await resolvePhoto(person.id, new Date(), { allowPull: true })).toBeNull();

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoSyncMisses).toBe(0);
    // The timestamp is still stamped, so a broken integration is not re-queried
    // on every single avatar render while it is down.
    expect(after.photoSyncedAt).not.toBeNull();
  });

  it("does not call Yalies again inside the backoff window", async () => {
    const person = await seedPerson({ photoSyncMisses: 1, photoSyncedAt: new Date() });

    // allowPull: true so this actually exercises the backoff check below it,
    // rather than passing trivially because allowPull itself (now default
    // false) already blocked the call for an unrelated reason.
    await resolvePhoto(person.id, new Date(), { allowPull: true });

    expect(vi.mocked(fetchYaliesPhoto)).not.toHaveBeenCalled();
  });

  it("serves the stored photo without calling Yalies", async () => {
    const person = await seedPerson();
    await setPhotoFromUpload(
      person.id,
      { type: "image/png", size: 100, bytes: await pngBytes() },
      4,
      person.id
    );

    const resolved = await resolvePhoto(person.id);

    expect(resolved).not.toBeNull();
    expect(vi.mocked(fetchYaliesPhoto)).not.toHaveBeenCalled();
  });

  it("returns null for an unknown person", async () => {
    expect(await resolvePhoto("does-not-exist")).toBeNull();
  });

  it("pulls from Yalies when allowPull is explicitly true, as the route passes for a self-view", async () => {
    vi.mocked(fetchYaliesPhoto).mockResolvedValue({ bytes: await pngBytes() });
    const person = await seedPerson();

    const resolved = await resolvePhoto(person.id, new Date(), { allowPull: true });

    expect(resolved).not.toBeNull();
    expect(vi.mocked(fetchYaliesPhoto)).toHaveBeenCalled();
  });

  it("never pulls from Yalies when allowPull is false, even inside the fetch window", async () => {
    const person = await seedPerson();

    const resolved = await resolvePhoto(person.id, new Date(), { allowPull: false });

    expect(resolved).toBeNull();
    expect(vi.mocked(fetchYaliesPhoto)).not.toHaveBeenCalled();
  });

  it("never pulls from Yalies when allowPull is omitted (default denies, the amplification guard)", async () => {
    const person = await seedPerson();

    const resolved = await resolvePhoto(person.id);

    expect(resolved).toBeNull();
    expect(vi.mocked(fetchYaliesPhoto)).not.toHaveBeenCalled();
  });

  it("still serves a stored photo when allowPull is false", async () => {
    const person = await seedPerson();
    await setPhotoFromUpload(
      person.id,
      { type: "image/png", size: 100, bytes: await pngBytes() },
      4,
      person.id
    );

    const resolved = await resolvePhoto(person.id, new Date(), { allowPull: false });

    expect(resolved).not.toBeNull();
    expect(vi.mocked(fetchYaliesPhoto)).not.toHaveBeenCalled();
  });

  it("records no miss when no API key is configured", async () => {
    vi.mocked(isYaliesEnabled).mockReturnValue(false);
    const person = await seedPerson();

    // allowPull: true so this actually exercises the isYaliesEnabled check,
    // not the allowPull gate that would otherwise block it first for an
    // unrelated reason.
    expect(await resolvePhoto(person.id, new Date(), { allowPull: true })).toBeNull();

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoSyncMisses).toBe(0);
    expect(after.photoSyncedAt).toBeNull();
    expect(vi.mocked(fetchYaliesPhoto)).not.toHaveBeenCalled();
  });

  it("repairs a torn row when the stored object is gone, then re-attempts Yalies", async () => {
    const person = await seedPerson();
    await setPhotoFromUpload(
      person.id,
      { type: "image/png", size: 100, bytes: await pngBytes() },
      4,
      person.id
    );
    const before = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(before.photoKey).toBe(`people/${person.id}`);

    // Simulate the object storage losing the bytes out from under the row,
    // without going through removePhoto (which would update the row too).
    await deleteObject(`people/${person.id}`);
    vi.mocked(fetchYaliesPhoto).mockResolvedValue({ bytes: await pngBytes() });

    const resolved = await resolvePhoto(person.id, new Date(), { allowPull: true });

    // The repair clears photoKey/photoSource and bumps photoVersion, then
    // policy is re-evaluated against that repaired state in the same call, so
    // a Yalies pull can backfill it immediately.
    expect(resolved).not.toBeNull();
    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoSource).toBe("yalies");
    expect(after.photoVersion).toBeGreaterThan(before.photoVersion);
    expect(after.photoSuppressed).toBe(false);
  });

  it("repairs a torn row without touching an existing suppression", async () => {
    const person = await seedPerson();
    const key = `people/${person.id}`;
    // Seed a torn AND suppressed row directly, rather than via
    // resolvePhoto/removePhoto: photoKey pointing at an object that was
    // never actually written (getObject on it will miss, triggering
    // repair), with photoSuppressed already true. Seeding false here (the
    // column default) could not tell "repair leaves suppression alone" apart
    // from "repair wrongly resets suppression to false": both read false
    // either way. Only seeding true, and asserting it is STILL true
    // afterward, actually exercises the "untouched" claim.
    await prisma.person.update({
      where: { id: person.id },
      data: { photoKey: key, photoSource: "yalies", photoSuppressed: true },
    });
    vi.mocked(fetchYaliesPhoto).mockResolvedValue({ miss: "no_image" });

    // allowPull: true so this actually exercises the suppression check
    // inside shouldAttemptYaliesPull, not the allowPull gate.
    expect(await resolvePhoto(person.id, new Date(), { allowPull: true })).toBeNull();

    // Suppressed, so the repaired (photoKey: null) state must never reach a
    // Yalies pull at all: shouldAttemptYaliesPull's suppression check must
    // still see it as true.
    expect(vi.mocked(fetchYaliesPhoto)).not.toHaveBeenCalled();
    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoKey).toBeNull();
    expect(after.photoSource).toBeNull();
    expect(after.photoSuppressed).toBe(true);
  });

  it("does not let a Yalies pull clobber a photo the member uploaded during the pull window", async () => {
    const person = await seedPerson();

    // Simulate the member uploading their own photo WHILE this Yalies fetch is
    // in flight: the mock runs the upload as a side effect before resolving,
    // landing it squarely inside the fetch-then-normalize window that
    // storePhoto's conditional claim exists to guard.
    vi.mocked(fetchYaliesPhoto).mockImplementation(async () => {
      await setPhotoFromUpload(
        person.id,
        { type: "image/png", size: 100, bytes: await pngBytes() },
        4,
        person.id
      );
      return { bytes: await pngBytes() };
    });

    const resolved = await resolvePhoto(person.id, new Date(), { allowPull: true });

    // The Yalies write must lose this race: photoKey was no longer null by
    // the time its conditional claim ran, so it must fall back to initials
    // rather than reporting success while having overwritten the member's
    // own choice with the Yale photo.
    expect(resolved).toBeNull();
    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoSource).toBe("upload");
    expect(after.photoVersion).toBe(1);
  });
});

describe("setPhotoFromUpload", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("stores the photo and marks it upload-sourced", async () => {
    const person = await seedPerson();

    await setPhotoFromUpload(
      person.id,
      { type: "image/png", size: 100, bytes: await pngBytes() },
      4,
      person.id
    );

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoSource).toBe("upload");
    expect(after.photoKey).toBe(`people/${person.id}`);
    expect(after.photoVersion).toBe(1);
  });

  it("clears suppression when the actor uploading is the target person themselves", async () => {
    const person = await seedPerson({ photoSuppressed: true });

    await setPhotoFromUpload(
      person.id,
      { type: "image/png", size: 100, bytes: await pngBytes() },
      4,
      person.id
    );

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoSuppressed).toBe(false);
  });

  it("leaves an existing suppression untouched when an admin uploads on someone else's behalf", async () => {
    // The failure this guards: an admin uploading a headshot for a member who
    // previously opted out must NOT be treated as that member's own
    // affirmative override. Only a matching actorId/personId may clear
    // photoSuppressed (see storePhoto's doc comment).
    const person = await seedPerson({ photoSuppressed: true });
    const admin = await prisma.person.create({ data: { name: "Admin Person" } });

    await setPhotoFromUpload(
      person.id,
      { type: "image/png", size: 100, bytes: await pngBytes() },
      4,
      admin.id
    );

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoSource).toBe("upload");
    expect(after.photoKey).toBe(`people/${person.id}`);
    expect(after.photoSuppressed).toBe(true);
  });

  it("rejects an unsupported type", async () => {
    const person = await seedPerson();

    await expect(
      setPhotoFromUpload(
        person.id,
        { type: "application/pdf", size: 100, bytes: Buffer.from("x") },
        4,
        person.id
      )
    ).rejects.toBeInstanceOf(PhotoError);
  });

  it("rejects a file over the size limit", async () => {
    const person = await seedPerson();

    await expect(
      setPhotoFromUpload(
        person.id,
        { type: "image/png", size: 9 * 1024 * 1024, bytes: await pngBytes() },
        4,
        person.id
      )
    ).rejects.toBeInstanceOf(PhotoError);
  });

  it("rejects a file whose actual bytes exceed the limit even when the declared size lies", async () => {
    const person = await seedPerson();
    // size claims small; the actual buffer is the thing that must be judged.
    // Matching the specific "too large" message (rather than just
    // PhotoError) matters: these bytes are not a decodable image either, so
    // a validator that skipped this check would still reject them via
    // normalizePhoto's decode failure, with a different message, and the
    // test would pass for the wrong reason.
    const oversized = Buffer.alloc(5 * 1024 * 1024);

    await expect(
      setPhotoFromUpload(person.id, { type: "image/png", size: 100, bytes: oversized }, 4, person.id)
    ).rejects.toThrow(/too large/);
  });

  it("keeps the version monotonic across replacement", async () => {
    const person = await seedPerson();
    const file = { type: "image/png", size: 100, bytes: await pngBytes() };

    await setPhotoFromUpload(person.id, file, 4, person.id);
    await removePhoto(person.id);
    await setPhotoFromUpload(person.id, file, 4, person.id);

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoVersion).toBe(3);
  });
});

describe("removePhoto", () => {
  beforeEach(async () => {
    await resetDb();
    vi.mocked(isYaliesEnabled).mockReturnValue(true);
    vi.mocked(fetchYaliesPhoto).mockResolvedValue({ bytes: await pngBytes() });
  });

  it("suppresses future pulls when removing a Yalies photo", async () => {
    const person = await seedPerson();
    await resolvePhoto(person.id, new Date(), { allowPull: true });

    await removePhoto(person.id);

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoKey).toBeNull();
    expect(after.photoSuppressed).toBe(true);
    expect(await getObject(`people/${person.id}`)).toBeNull();
  });

  it("does not suppress when removing an uploaded photo, even if already suppressed", async () => {
    const person = await seedPerson();
    const key = `people/${person.id}`;
    // Seed a state that the app's own functions cannot reach on their own
    // (setPhotoFromUpload always clears suppression on the way in, per
    // "clears suppression" above), but that the schema does not forbid:
    // source "upload" with photoSuppressed already true. Seeding false here
    // (the column default) could not distinguish "removePhoto correctly
    // left it alone" from "removePhoto wrote false anyway": both read false
    // either way, which is exactly the gap that let the absolute-value write
    // in removePhoto through review undetected. Only seeding true, and
    // asserting it survives, actually exercises "an uploaded-photo removal
    // must not touch suppression in either direction."
    await prisma.person.update({
      where: { id: person.id },
      data: { photoKey: key, photoSource: "upload", photoSuppressed: true },
    });

    await removePhoto(person.id);

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoKey).toBeNull();
    expect(after.photoSuppressed).toBe(true);
  });

  it("leaves a suppressed person alone on a later resolve", async () => {
    const person = await seedPerson();
    await resolvePhoto(person.id, new Date(), { allowPull: true });
    await removePhoto(person.id);
    vi.mocked(fetchYaliesPhoto).mockClear();

    // allowPull: true here too: the point of this test is that suppression
    // blocks the pull, not that the caller forgot to ask for one.
    expect(await resolvePhoto(person.id, new Date(), { allowPull: true })).toBeNull();
    expect(vi.mocked(fetchYaliesPhoto)).not.toHaveBeenCalled();
  });

  it("a second removePhoto call does not un-suppress an already-removed Yalies photo", async () => {
    const person = await seedPerson();
    await resolvePhoto(person.id, new Date(), { allowPull: true });

    await removePhoto(person.id);
    const afterFirst = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(afterFirst.photoSuppressed).toBe(true);

    // Double-clicked remove button, a retried form post, or an admin
    // removing a photo for someone who already removed it: photoKey is
    // already null, so this call has nothing to do.
    await removePhoto(person.id);

    const afterSecond = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(afterSecond.photoSuppressed).toBe(true);
    // A true no-op: the second call must not have written the row at all.
    expect(afterSecond.photoVersion).toBe(afterFirst.photoVersion);
  });
});

describe("an opt-out survives an admin re-upload and its own removal", () => {
  beforeEach(async () => {
    await resetDb();
    vi.mocked(isYaliesEnabled).mockReturnValue(true);
  });

  it("stays suppressed through the full sequence: opt out, admin upload, member removes it, next render", async () => {
    const jane = await seedPerson();
    const admin = await prisma.person.create({ data: { name: "Admin Person" } });

    // 1. Jane is auto-sourced, then removes it on /my-info. photoSuppressed
    //    becomes true, photoSource/photoKey go back to null.
    vi.mocked(fetchYaliesPhoto).mockResolvedValue({ bytes: await pngBytes() });
    await resolvePhoto(jane.id, new Date(), { allowPull: true });
    await removePhoto(jane.id);
    const afterOptOut = await prisma.person.findUniqueOrThrow({ where: { id: jane.id } });
    expect(afterOptOut.photoSuppressed).toBe(true);
    expect(afterOptOut.photoKey).toBeNull();

    // 2. An admin (NOT Jane) uploads a headshot for her.
    await setPhotoFromUpload(
      jane.id,
      { type: "image/png", size: 100, bytes: await pngBytes() },
      4,
      admin.id
    );
    const afterAdminUpload = await prisma.person.findUniqueOrThrow({ where: { id: jane.id } });
    // The core of F1: an admin upload is not Jane's own affirmative
    // override, so her opt-out must survive it untouched.
    expect(afterAdminUpload.photoSource).toBe("upload");
    expect(afterAdminUpload.photoSuppressed).toBe(true);

    // 3. Jane removes that admin-uploaded photo. Source is "upload", not
    //    "yalies", so removePhoto correctly leaves suppression as-is (still
    //    true -- it was never false to begin with here).
    await removePhoto(jane.id);
    const afterRemoval = await prisma.person.findUniqueOrThrow({ where: { id: jane.id } });
    expect(afterRemoval.photoKey).toBeNull();
    expect(afterRemoval.photoSuppressed).toBe(true);

    // 4. Her next render must NOT re-pull her Yale photo and must NOT
    //    republish it to her public credential page. allowPull: true here
    //    so this proves suppression is what blocks the pull, matching a
    //    self-view where the route would actually allow one.
    vi.mocked(fetchYaliesPhoto).mockClear();
    const resolved = await resolvePhoto(jane.id, new Date(), { allowPull: true });
    expect(resolved).toBeNull();
    expect(vi.mocked(fetchYaliesPhoto)).not.toHaveBeenCalled();
  });
});
