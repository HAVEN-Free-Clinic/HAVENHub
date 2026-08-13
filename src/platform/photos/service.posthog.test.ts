import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

vi.mock("@/platform/posthog/capture", () => ({ captureEvent: vi.fn() }));

vi.mock("./yalies", async (importOriginal) => {
  // isPersonSpecificMiss stays REAL: it is what decides the person_specific
  // property these tests assert on, so mocking it would make them vacuous.
  const actual = await importOriginal<typeof import("./yalies")>();
  return {
    ...actual,
    isYaliesEnabled: vi.fn(() => true),
    fetchYaliesPhoto: vi.fn(async () => ({ miss: "no_image" }) as const),
  };
});

import { captureEvent } from "@/platform/posthog/capture";
import { fetchYaliesPhoto, isYaliesEnabled } from "./yalies";
import { removePhoto, resolvePhoto, setPhotoFromUpload } from "./service";

type Captured = { event: string; distinctId: string; properties?: Record<string, unknown> };

/** Every captured event, in order. */
const captured = (): Captured[] =>
  vi.mocked(captureEvent).mock.calls.map((call) => call[0] as Captured);

/** The single captured event, asserting there was exactly one. */
function onlyEvent(): Captured {
  const events = captured();
  expect(events).toHaveLength(1);
  return events[0];
}

/** Real PNG bytes, so normalizePhoto has something it can actually decode. */
async function pngBytes(): Promise<Buffer> {
  return sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 9, g: 9, b: 9 } },
  })
    .png()
    .toBuffer();
}

async function seedPerson(overrides: Record<string, unknown> = {}) {
  return prisma.person.create({
    data: { name: "Ada Lovelace", netId: "abc12", yaleAffiliation: "yale_college", ...overrides },
  });
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  // mockReturnValue survives clearAllMocks, but re-arm both anyway so a future
  // test that overrides them cannot leak into the next one.
  vi.mocked(isYaliesEnabled).mockReturnValue(true);
  vi.mocked(fetchYaliesPhoto).mockResolvedValue({ miss: "no_image" });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("Yalies pull events", () => {
  it("reports a successful pull with the backoff step it was standing on", async () => {
    vi.mocked(fetchYaliesPhoto).mockResolvedValue({ bytes: await pngBytes() });
    const person = await seedPerson({
      photoSyncMisses: 2,
      photoSyncedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });

    await resolvePhoto(person.id, new Date(), { allowPull: true });

    expect(onlyEvent()).toMatchObject({
      event: "member_photo_pull_attempted",
      distinctId: person.id,
      // prior_misses is read BEFORE the write that resets it to 0. Reporting
      // the post-write value would erase exactly the fact worth knowing: this
      // member had been dark for two failed attempts.
      properties: { outcome: "sourced", prior_misses: 2 },
    });
  });

  it("carries the miss reason and marks a person-specific miss as such", async () => {
    const person = await seedPerson();

    await resolvePhoto(person.id, new Date(), { allowPull: true });

    expect(onlyEvent().properties).toMatchObject({
      outcome: "missed",
      reason: "no_image",
      person_specific: true,
      prior_misses: 0,
    });
  });

  it("marks an integration failure as NOT person-specific", async () => {
    // This is the discriminator the whole event exists for: a bad_host miss is
    // equally true of every member at that moment, so a spike of these is an
    // outage worth paging on, while a spike of no_image is just the roster.
    vi.mocked(fetchYaliesPhoto).mockResolvedValue({ miss: "bad_host" });
    const person = await seedPerson();

    await resolvePhoto(person.id, new Date(), { allowPull: true });

    expect(onlyEvent().properties).toMatchObject({
      outcome: "missed",
      reason: "bad_host",
      person_specific: false,
    });
  });

  it("reports bytes Yalies served that sharp cannot decode", async () => {
    vi.mocked(fetchYaliesPhoto).mockResolvedValue({ bytes: Buffer.from("not an image") });
    const person = await seedPerson();

    await resolvePhoto(person.id, new Date(), { allowPull: true });

    expect(onlyEvent().properties).toMatchObject({ outcome: "unreadable" });
  });

  it("stays silent when no pull was attempted", async () => {
    // The denominator has to be real round trips, not avatar renders: a rate
    // diluted by every view that policy declined would hide an outage. Three
    // ways a view reaches resolvePhoto without calling Yalies at all.
    const suppressed = await seedPerson({ netId: "sup01", photoSuppressed: true });
    await resolvePhoto(suppressed.id, new Date(), { allowPull: true });

    const backedOff = await seedPerson({
      netId: "bko01",
      photoSyncMisses: 1,
      photoSyncedAt: new Date(),
    });
    await resolvePhoto(backedOff.id, new Date(), { allowPull: true });

    vi.mocked(isYaliesEnabled).mockReturnValue(false);
    const noKey = await seedPerson({ netId: "nok01" });
    await resolvePhoto(noKey.id, new Date(), { allowPull: true });

    expect(captured()).toEqual([]);
    expect(vi.mocked(fetchYaliesPhoto)).not.toHaveBeenCalled();
  });
});

describe("upload and removal events", () => {
  it("distinguishes a member's own upload from an admin uploading for them", async () => {
    const person = await seedPerson();
    const admin = await seedPerson({ name: "Admin", netId: "adm01" });
    const file = { type: "image/png", size: 0, bytes: await pngBytes() };

    await setPhotoFromUpload(person.id, file, 10, person.id);
    expect(onlyEvent()).toMatchObject({
      event: "member_photo_uploaded",
      distinctId: person.id,
      properties: { by_self: true, content_type: "image/png" },
    });
    // The stored WebP, not the submitted PNG.
    expect(onlyEvent().properties?.bytes).toBeGreaterThan(0);

    vi.clearAllMocks();
    await setPhotoFromUpload(person.id, file, 10, admin.id);
    expect(onlyEvent().properties).toMatchObject({ by_self: false });
  });

  it("does not report an upload the service rejected", async () => {
    const person = await seedPerson();

    await expect(
      setPhotoFromUpload(person.id, { type: "image/gif", size: 10, bytes: Buffer.alloc(10) }, 10, person.id)
    ).rejects.toThrow();

    expect(captured()).toEqual([]);
  });

  it("reports removing a Yalies photo as a suppression and an upload as not", async () => {
    vi.mocked(fetchYaliesPhoto).mockResolvedValue({ bytes: await pngBytes() });
    const person = await seedPerson();
    await resolvePhoto(person.id, new Date(), { allowPull: true });
    vi.clearAllMocks();

    await removePhoto(person.id);
    expect(onlyEvent()).toMatchObject({
      event: "member_photo_removed",
      distinctId: person.id,
      properties: { previous_source: "yalies", suppressed: true },
    });

    // Same person, now with an upload: removing that one leaves backfill open,
    // so it is not an opt-out and must not be counted as one.
    await setPhotoFromUpload(
      person.id,
      { type: "image/png", size: 0, bytes: await pngBytes() },
      10,
      person.id
    );
    vi.clearAllMocks();

    await removePhoto(person.id);
    expect(onlyEvent().properties).toMatchObject({
      previous_source: "upload",
      suppressed: false,
    });
  });

  it("stays silent when there is nothing to remove", async () => {
    const person = await seedPerson();

    await removePhoto(person.id);
    await removePhoto("no-such-person");

    expect(captured()).toEqual([]);
  });
});
