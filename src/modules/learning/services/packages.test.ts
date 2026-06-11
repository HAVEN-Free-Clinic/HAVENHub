import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getObject } from "@/platform/storage";
import { LearningAuthError, LearningValidationError } from "./errors";
import { ingestScormPackage } from "./packages";
import { makeScormZip } from "./test-fixtures";

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

  expect(await getObject(`scorm/${course.id}/index.html`)).not.toBeNull();
  expect(await getObject(`scorm/${course.id}/assets/app.js`)).not.toBeNull();
});

it("rejects a zip with no imsmanifest.xml", async () => {
  const { manager, course } = await seed();
  const { zipSync, strToU8 } = await import("fflate");
  const bad = Buffer.from(zipSync({ "index.html": strToU8("<html></html>") }));
  await expect(ingestScormPackage(course.id, bad, manager.id)).rejects.toBeInstanceOf(LearningValidationError);
});

it("replacing a package removes files that are no longer present", async () => {
  const { manager, course } = await seed();
  await ingestScormPackage(course.id, makeScormZip(), manager.id);
  expect(await getObject(`scorm/${course.id}/assets/app.js`)).not.toBeNull();

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
  expect(await getObject(`scorm/${course.id}/index.html`)).not.toBeNull();
  expect(await getObject(`scorm/${course.id}/assets/app.js`)).toBeNull();
});
