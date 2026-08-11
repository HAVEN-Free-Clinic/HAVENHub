import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { deleteObject, getObject } from "@/platform/storage";
import { PhotoError } from "./shared";
import { removePhoto, resolvePhoto, setPhotoFromUpload } from "./service";

vi.mock("./yalies", () => ({
  isYaliesEnabled: vi.fn(() => true),
  fetchYaliesPhoto: vi.fn(async () => null),
}));

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
    vi.mocked(fetchYaliesPhoto).mockResolvedValue(null);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("stores and returns a photo when Yalies has one", async () => {
    vi.mocked(fetchYaliesPhoto).mockResolvedValue(await pngBytes());
    const person = await seedPerson();

    const resolved = await resolvePhoto(person.id);

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

    expect(await resolvePhoto(person.id)).toBeNull();

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoKey).toBeNull();
    expect(after.photoSyncMisses).toBe(1);
    expect(after.photoSyncedAt).not.toBeNull();
  });

  it("does not call Yalies again inside the backoff window", async () => {
    const person = await seedPerson({ photoSyncMisses: 1, photoSyncedAt: new Date() });

    await resolvePhoto(person.id);

    expect(vi.mocked(fetchYaliesPhoto)).not.toHaveBeenCalled();
  });

  it("serves the stored photo without calling Yalies", async () => {
    const person = await seedPerson();
    await setPhotoFromUpload(person.id, { type: "image/png", size: 100, bytes: await pngBytes() }, 4);

    const resolved = await resolvePhoto(person.id);

    expect(resolved).not.toBeNull();
    expect(vi.mocked(fetchYaliesPhoto)).not.toHaveBeenCalled();
  });

  it("returns null for an unknown person", async () => {
    expect(await resolvePhoto("does-not-exist")).toBeNull();
  });

  it("records no miss when no API key is configured", async () => {
    vi.mocked(isYaliesEnabled).mockReturnValue(false);
    const person = await seedPerson();

    expect(await resolvePhoto(person.id)).toBeNull();

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoSyncMisses).toBe(0);
    expect(after.photoSyncedAt).toBeNull();
    expect(vi.mocked(fetchYaliesPhoto)).not.toHaveBeenCalled();
  });

  it("repairs a torn row when the stored object is gone, then re-attempts Yalies", async () => {
    const person = await seedPerson();
    await setPhotoFromUpload(person.id, { type: "image/png", size: 100, bytes: await pngBytes() }, 4);
    const before = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(before.photoKey).toBe(`people/${person.id}`);

    // Simulate the object storage losing the bytes out from under the row,
    // without going through removePhoto (which would update the row too).
    await deleteObject(`people/${person.id}`);
    vi.mocked(fetchYaliesPhoto).mockResolvedValue(await pngBytes());

    const resolved = await resolvePhoto(person.id);

    // The repair clears photoKey/photoSource and bumps photoVersion, then
    // policy is re-evaluated against that repaired state in the same call, so
    // a Yalies pull can backfill it immediately.
    expect(resolved).not.toBeNull();
    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoSource).toBe("yalies");
    expect(after.photoVersion).toBeGreaterThan(before.photoVersion);
    expect(after.photoSuppressed).toBe(false);
  });

  it("repairs a torn row without suppressing, even when Yalies has nothing to backfill", async () => {
    const person = await seedPerson();
    await setPhotoFromUpload(person.id, { type: "image/png", size: 100, bytes: await pngBytes() }, 4);
    const before = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });

    await deleteObject(`people/${person.id}`);
    vi.mocked(fetchYaliesPhoto).mockResolvedValue(null);

    expect(await resolvePhoto(person.id)).toBeNull();

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoKey).toBeNull();
    expect(after.photoSource).toBeNull();
    expect(after.photoVersion).toBe(before.photoVersion + 1);
    expect(after.photoSuppressed).toBe(false);
  });
});

describe("setPhotoFromUpload", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("stores the photo and marks it upload-sourced", async () => {
    const person = await seedPerson();

    await setPhotoFromUpload(person.id, { type: "image/png", size: 100, bytes: await pngBytes() }, 4);

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoSource).toBe("upload");
    expect(after.photoKey).toBe(`people/${person.id}`);
    expect(after.photoVersion).toBe(1);
  });

  it("clears suppression", async () => {
    const person = await seedPerson({ photoSuppressed: true });

    await setPhotoFromUpload(person.id, { type: "image/png", size: 100, bytes: await pngBytes() }, 4);

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoSuppressed).toBe(false);
  });

  it("rejects an unsupported type", async () => {
    const person = await seedPerson();

    await expect(
      setPhotoFromUpload(person.id, { type: "application/pdf", size: 100, bytes: Buffer.from("x") }, 4)
    ).rejects.toBeInstanceOf(PhotoError);
  });

  it("rejects a file over the size limit", async () => {
    const person = await seedPerson();

    await expect(
      setPhotoFromUpload(
        person.id,
        { type: "image/png", size: 9 * 1024 * 1024, bytes: await pngBytes() },
        4
      )
    ).rejects.toBeInstanceOf(PhotoError);
  });

  it("keeps the version monotonic across replacement", async () => {
    const person = await seedPerson();
    const file = { type: "image/png", size: 100, bytes: await pngBytes() };

    await setPhotoFromUpload(person.id, file, 4);
    await removePhoto(person.id);
    await setPhotoFromUpload(person.id, file, 4);

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoVersion).toBe(3);
  });
});

describe("removePhoto", () => {
  beforeEach(async () => {
    await resetDb();
    vi.mocked(isYaliesEnabled).mockReturnValue(true);
    vi.mocked(fetchYaliesPhoto).mockResolvedValue(await pngBytes());
  });

  it("suppresses future pulls when removing a Yalies photo", async () => {
    const person = await seedPerson();
    await resolvePhoto(person.id);

    await removePhoto(person.id);

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoKey).toBeNull();
    expect(after.photoSuppressed).toBe(true);
    expect(await getObject(`people/${person.id}`)).toBeNull();
  });

  it("does not suppress when removing an uploaded photo", async () => {
    const person = await seedPerson();
    await setPhotoFromUpload(person.id, { type: "image/png", size: 100, bytes: await pngBytes() }, 4);

    await removePhoto(person.id);

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoKey).toBeNull();
    expect(after.photoSuppressed).toBe(false);
  });

  it("leaves a suppressed person alone on a later resolve", async () => {
    const person = await seedPerson();
    await resolvePhoto(person.id);
    await removePhoto(person.id);
    vi.mocked(fetchYaliesPhoto).mockClear();

    expect(await resolvePhoto(person.id)).toBeNull();
    expect(vi.mocked(fetchYaliesPhoto)).not.toHaveBeenCalled();
  });
});
