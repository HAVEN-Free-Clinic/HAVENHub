/**
 * TDD test for the grandfather migration.
 *
 * Reads and executes the actual shipped migration.sql so the test exercises
 * the exact SQL that deploys via `prisma migrate deploy`.
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

// vitest cwd is the repo root, so this relative path resolves correctly.
const MIGRATION_SQL = readFileSync(
  "prisma/migrations/20260629120000_grandfather_unverified_hipaa_dates/migration.sql",
  "utf8"
);

describe("grandfather unverified HIPAA dates", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("back-stamps dated-unverified certs and leaves dateless certs untouched", async () => {
    const person = await prisma.person.create({ data: { name: "T", status: "ACTIVE" } });

    const dated = await prisma.hipaaCertificate.create({
      data: {
        personId: person.id,
        fileName: "a.pdf",
        storedName: "a.pdf",
        size: 1,
        mimeType: "application/pdf",
        completionDate: new Date("2026-01-01T12:00:00Z"),
      },
    });

    const dateless = await prisma.hipaaCertificate.create({
      data: {
        personId: person.id,
        fileName: "b.pdf",
        storedName: "b.pdf",
        size: 1,
        mimeType: "application/pdf",
        // completionDate intentionally omitted
      },
    });

    // Execute the exact SQL shipped in the migration file.
    await prisma.$executeRawUnsafe(MIGRATION_SQL);

    const a = await prisma.hipaaCertificate.findUniqueOrThrow({ where: { id: dated.id } });
    const b = await prisma.hipaaCertificate.findUniqueOrThrow({ where: { id: dateless.id } });

    // Dated cert must now have verifiedAt set (grandfathered).
    expect(a.verifiedAt).not.toBeNull();
    // Dateless cert must remain unverified (not affected by the migration).
    expect(b.verifiedAt).toBeNull();
  });
});
