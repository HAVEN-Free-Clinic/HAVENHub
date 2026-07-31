import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getObject } from "@/platform/storage";
import { LearningAuthError, LearningValidationError } from "./errors";
import { ingestScormPackage } from "./packages";
import { makeScormZip, makeMultiScoZip } from "./test-fixtures";

async function seed() {
  const manager = await prisma.person.create({ data: { name: "Mgr", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "Learning Admin", grants: { create: [{ permission: "learning.manage_courses" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: manager.id, roleId: role.id } });
  const plain = await prisma.person.create({ data: { name: "Plain", status: "ACTIVE" } });
  const course = await prisma.course.create({ data: { title: "Intro" } });
  return { manager, plain, course };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("rejects ingest without the manage permission", async () => {
  const { plain, course } = await seed();
  await expect(ingestScormPackage(course.id, makeScormZip(), plain.id)).rejects.toBeInstanceOf(LearningAuthError);
});

it("stores package files and sets the course entry href + version", async () => {
  const { manager, course } = await seed();
  await ingestScormPackage(course.id, makeScormZip(), manager.id);

  const updated = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
  expect(updated.scormEntryHref).toBe("index.html");
  expect(updated.scormVersion).toBe("1.2");
  expect(updated.scormUploadedAt).not.toBeNull();
  expect(updated.scormBlobKey).not.toBeNull();

  // Files live under the per-upload versioned prefix scorm/<courseId>/<key>/.
  expect(await getObject(`scorm/${course.id}/${updated.scormBlobKey}/index.html`)).not.toBeNull();
  expect(await getObject(`scorm/${course.id}/${updated.scormBlobKey}/assets/app.js`)).not.toBeNull();
});

it("stores the ordered SCO list on the course", async () => {
  const { manager, course } = await seed();
  await ingestScormPackage(course.id, makeMultiScoZip(), manager.id);

  const updated = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
  expect(updated.scormEntryHref).toBe("index.html");
  expect(updated.scormScos).toEqual([
    { id: "ITEM-A", title: "hb", href: "index.html" },
    { id: "ITEM-B", title: "ytf", href: "html/ytf.html" },
  ]);
  expect(await getObject(`scorm/${course.id}/${updated.scormBlobKey}/html/ytf.html`)).not.toBeNull();
});

it("rejects a zip with no imsmanifest.xml", async () => {
  const { manager, course } = await seed();
  const { zipSync, strToU8 } = await import("fflate");
  const bad = Buffer.from(zipSync({ "index.html": strToU8("<html></html>") }));
  await expect(ingestScormPackage(course.id, bad, manager.id)).rejects.toBeInstanceOf(LearningValidationError);
});

it("rejects a package with too many files (the decompression-guard filter counts as it reads)", async () => {
  const { manager, course } = await seed();
  const { zipSync, strToU8 } = await import("fflate");
  const entries: Record<string, Uint8Array> = {};
  for (let i = 0; i < 2001; i++) entries[`f${i}.txt`] = strToU8("x"); // MAX_FILES is 2000
  const zip = Buffer.from(zipSync(entries));
  await expect(ingestScormPackage(course.id, zip, manager.id)).rejects.toThrow(/too many files/);
});

it("re-ingesting with resetProgress clears prior course and per-SCO progress", async () => {
  const { manager, plain, course } = await seed();
  await ingestScormPackage(course.id, makeMultiScoZip(), manager.id);

  // A learner completed the OLD package.
  await prisma.courseProgress.create({
    data: { personId: plain.id, courseId: course.id, status: "COMPLETE", lessonStatus: "completed", completedAt: new Date() },
  });
  await prisma.scoProgress.createMany({
    data: [
      { personId: plain.id, courseId: course.id, scoId: "ITEM-A", lessonStatus: "completed" },
      { personId: plain.id, courseId: course.id, scoId: "ITEM-B", lessonStatus: "completed" },
    ],
  });

  // Replace with a different package and ask to reset progress.
  await ingestScormPackage(course.id, makeScormZip(), manager.id, { resetProgress: true });

  expect(await prisma.courseProgress.count({ where: { courseId: course.id } })).toBe(0);
  expect(await prisma.scoProgress.count({ where: { courseId: course.id } })).toBe(0);
});

it("re-ingesting with resetProgress clears progress across every term, not just the active one (the content itself changed, so no term's row is a valid completion of it)", async () => {
  const { manager, plain, course } = await seed();
  await ingestScormPackage(course.id, makeMultiScoZip(), manager.id);

  const termA = await prisma.term.create({
    data: { code: "SU25", name: "Prior", status: "ARCHIVED", startDate: new Date("2025-01-01"), endDate: new Date("2025-06-30") },
  });
  await prisma.courseProgress.create({
    data: { personId: plain.id, courseId: course.id, termId: termA.id, status: "COMPLETE", lessonStatus: "completed", completedAt: new Date() },
  });

  await ingestScormPackage(course.id, makeScormZip(), manager.id, { resetProgress: true });

  expect(await prisma.courseProgress.count({ where: { courseId: course.id } })).toBe(0);
});

it("re-ingesting without resetProgress preserves prior progress", async () => {
  const { manager, plain, course } = await seed();
  await ingestScormPackage(course.id, makeMultiScoZip(), manager.id);
  await prisma.courseProgress.create({
    data: { personId: plain.id, courseId: course.id, status: "COMPLETE", lessonStatus: "completed", completedAt: new Date() },
  });
  await prisma.scoProgress.create({
    data: { personId: plain.id, courseId: course.id, scoId: "ITEM-A", lessonStatus: "completed" },
  });

  await ingestScormPackage(course.id, makeScormZip(), manager.id);

  expect(await prisma.courseProgress.count({ where: { courseId: course.id } })).toBe(1);
  expect(await prisma.scoProgress.count({ where: { courseId: course.id } })).toBe(1);
});

it("replacing a package stages under a new key and cleans up the old package", async () => {
  const { manager, course } = await seed();
  await ingestScormPackage(course.id, makeScormZip(), manager.id);
  const afterA = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
  const keyA = afterA.scormBlobKey!;
  expect(await getObject(`scorm/${course.id}/${keyA}/assets/app.js`)).not.toBeNull();

  const { zipSync, strToU8 } = await import("fflate");
  const slim = Buffer.from(
    zipSync({
      "imsmanifest.xml": strToU8(
        `<manifest xmlns="x" xmlns:adlcp="y"><organizations default="O"><organization identifier="O"><item identifier="I" identifierref="R"/></organization></organizations><resources><resource identifier="R" adlcp:scormtype="sco" href="index.html"/></resources></manifest>`
      ),
      "index.html": strToU8("<html>v2</html>"),
    })
  );
  await ingestScormPackage(course.id, slim, manager.id);

  const afterB = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
  const keyB = afterB.scormBlobKey!;
  expect(keyB).not.toBe(keyA);
  // New package served from the new key.
  expect(await getObject(`scorm/${course.id}/${keyB}/index.html`)).not.toBeNull();
  // Old package fully cleaned up.
  expect(await getObject(`scorm/${course.id}/${keyA}/index.html`)).toBeNull();
  expect(await getObject(`scorm/${course.id}/${keyA}/assets/app.js`)).toBeNull();
});

it("keeps the previous package intact when the DB manifest write fails mid-replace (audit F17)", async () => {
  const { manager, course } = await seed();
  await ingestScormPackage(course.id, makeScormZip(), manager.id);
  const afterA = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
  const keyA = afterA.scormBlobKey!;

  // Force the manifest update to fail AFTER the new blobs are staged.
  const spy = vi.spyOn(prisma.course, "update").mockRejectedValueOnce(new Error("db down"));
  try {
    await expect(ingestScormPackage(course.id, makeMultiScoZip(), manager.id)).rejects.toThrow(/db down/);
  } finally {
    spy.mockRestore();
  }

  // The course still points at package A (manifest untouched), and A's files are
  // still present and served -- no broken course pointing at deleted files.
  const afterFail = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
  expect(afterFail.scormBlobKey).toBe(keyA);
  expect(await getObject(`scorm/${course.id}/${keyA}/index.html`)).not.toBeNull();
});
