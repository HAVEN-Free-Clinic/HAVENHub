/**
 * SCORM ingest upload concurrency (audit 14, scorm-ingest-serial-uploads).
 *
 * Its own file because the assertion needs `@/platform/storage` mocked, and
 * packages.test.ts reads back through the real getObject.
 *
 * What is under test is the SHAPE of the upload loop, not its output: a serial
 * loop and a bounded-parallel one store exactly the same files, which is why
 * every existing ingest test passes either way. So the mock records how many
 * writes are in flight at once.
 */

import { beforeEach, expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { LearningValidationError } from "./errors";
import { ingestScormPackage } from "./packages";

const tracker = vi.hoisted(() => ({ inFlight: 0, peak: 0, keys: [] as string[] }));

vi.mock("@/platform/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/storage")>();
  return {
    ...actual,
    putObject: vi.fn(async (key: string, bytes: Buffer, contentType: string) => {
      tracker.inFlight += 1;
      tracker.peak = Math.max(tracker.peak, tracker.inFlight);
      tracker.keys.push(key);
      // A real PUT is a network round trip; without a turn of the event loop a
      // serial loop and a parallel one are indistinguishable.
      await new Promise((resolve) => setTimeout(resolve, 2));
      tracker.inFlight -= 1;
      return actual.putObject(key, bytes, contentType);
    }),
  };
});

const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MAN-1" version="1.2"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>Course</title>
      <item identifier="ITEM-1" identifierref="RES-1"><title>Lesson</title></item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-1" type="webcontent" adlcp:scormtype="sco" href="index.html">
      <file href="index.html"/>
    </resource>
  </resources>
</manifest>`;

/** A valid package padded out to `assetCount` extra asset files. */
function makeWidePackage(assetCount: number, extra: Record<string, string> = {}): Buffer {
  const files: Record<string, Uint8Array> = {
    "imsmanifest.xml": strToU8(MANIFEST),
    "index.html": strToU8("<!doctype html><title>Lesson</title>"),
  };
  for (let i = 0; i < assetCount; i++) {
    files[`assets/a${i}.js`] = strToU8(`console.log(${i});`);
  }
  for (const [name, body] of Object.entries(extra)) files[name] = strToU8(body);
  return Buffer.from(zipSync(files));
}

async function seed() {
  const manager = await prisma.person.create({ data: { name: "Mgr", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: {
      name: "Learning Admin",
      grants: { create: [{ permission: "learning.manage_courses" }] },
    },
  });
  await prisma.roleAssignment.create({ data: { personId: manager.id, roleId: role.id } });
  const course = await prisma.course.create({ data: { title: "Intro" } });
  return { manager, course };
}

beforeEach(async () => {
  await resetDb();
  tracker.inFlight = 0;
  tracker.peak = 0;
  tracker.keys = [];
});

it("uploads package files in parallel, bounded", async () => {
  const { manager, course } = await seed();

  await ingestScormPackage(course.id, makeWidePackage(40), manager.id);

  // 42 entries: manifest + index.html + 40 assets. All of them stored.
  expect(tracker.keys).toHaveLength(42);
  // The defect: a strictly serial loop never has two writes in flight.
  expect(tracker.peak).toBeGreaterThan(1);
  // And the bound: an unbounded Promise.all over 2000 entries is the other bug.
  expect(tracker.peak).toBeLessThanOrEqual(8);
});

it("rejects an unsafe entry name before writing anything", async () => {
  const { manager, course } = await seed();
  // fflate keeps the name verbatim, so this is what a hand-built malicious zip
  // looks like. Serially, every entry sorted ahead of it was already uploaded
  // under a prefix the failed ingest never records and therefore never cleans.
  const zip = makeWidePackage(10, { "../escape.js": "console.log('nope');" });

  await expect(ingestScormPackage(course.id, zip, manager.id)).rejects.toBeInstanceOf(
    LearningValidationError
  );
  expect(tracker.keys).toEqual([]);
});
