import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

/** Playwright does not auto-load .env; read DATABASE_URL from env with a .env fallback. */
function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = readFileSync(".env", "utf8");
  const m = env.match(/^DATABASE_URL=['"]?([^'"\n]+)/m);
  if (!m) throw new Error("DATABASE_URL not found in process.env or .env");
  return m[1];
}

/** e2e-only client; NOT the app's server-only singleton. */
export const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl() } },
});

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY);

/** Unique, greppable suffix so live-DB rows never collide. */
export function tag(): string {
  return `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function activeTerm() {
  return prisma.term.findFirstOrThrow({ where: { status: "ACTIVE" } });
}
async function dept(code: string) {
  return prisma.department.findUniqueOrThrow({ where: { code } });
}

/** Remove a person and every row that references it (run before the person delete). */
export async function cleanupPerson(personId: string): Promise<void> {
  // Remove shift-level data first (FK deps before membership/person delete).
  await prisma.shiftRequest.deleteMany({ where: { personId } }).catch(() => {});
  await prisma.shiftAssignment.deleteMany({ where: { personId } }).catch(() => {});
  await prisma.hipaaCertificate.deleteMany({ where: { personId } });
  await prisma.notification.deleteMany({ where: { personId } });
  await prisma.termMembership.deleteMany({ where: { personId } });
  await prisma.person.delete({ where: { id: personId } }).catch((e) => console.warn("[e2e cleanup] delete failed, row may be leaked:", e instanceof Error ? e.message : e));
}

export async function seedComplianceMember(
  deptCode: string,
  opts: {
    status?: "COMPLIANT" | "EXPIRING_SOON" | "EXPIRED" | "DATE_UNKNOWN";
    kind?: "VOLUNTEER" | "DIRECTOR";
  } = {}
) {
  const status = opts.status ?? "COMPLIANT";
  const kind = opts.kind ?? "VOLUNTEER";
  const term = await activeTerm();
  const department = await dept(deptCode);
  const t = tag();
  const person = await prisma.person.create({
    data: { name: `E2E Member ${t}`, contactEmail: `${t}@example.test` },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: department.id, kind, status: "ACTIVE" },
  });
  // Cert validity is completionDate + 365d. Offsets chosen to land in each status bucket.
  // Final offsets are tuned during the task against src/modules/volunteers/services/compliance.ts.
  const completion: Record<string, Date | null> = {
    COMPLIANT: daysFromNow(-10),
    EXPIRING_SOON: daysFromNow(-340),
    EXPIRED: daysFromNow(-400),
    DATE_UNKNOWN: null,
  };
  await prisma.hipaaCertificate.create({
    data: {
      personId: person.id,
      fileName: "e2e.pdf",
      storedName: `${t}.pdf`,
      size: 100,
      mimeType: "application/pdf",
      completionDate: completion[status],
      verifiedAt: new Date(), // verified so the status actually gates
    },
  });
  return { person, cleanup: () => cleanupPerson(person.id) };
}

export async function seedNotification(
  personId: string,
  opts: { type?: string; title?: string; body?: string; link?: string } = {}
) {
  const t = tag();
  const row = await prisma.notification.create({
    data: {
      personId,
      type: opts.type ?? "e2e",
      title: opts.title ?? `E2E notice ${t}`,
      body: opts.body ?? "An end-to-end test notification.",
      link: opts.link ?? null,
    },
  });
  return {
    id: row.id,
    cleanup: () => prisma.notification.delete({ where: { id: row.id } }).then(() => {}).catch((e) => console.warn("[e2e cleanup] delete failed, row may be leaked:", e instanceof Error ? e.message : e)),
  };
}

export async function seedCourseWithPackage(
  opts: { title?: string; assignToAll?: boolean } = {}
) {
  const t = tag();
  const course = await prisma.course.create({
    data: {
      title: opts.title ?? `E2E Course ${t}`,
      isActive: true,
      assignToAll: opts.assignToAll ?? true,
      // Marks the course as having an ingested package so it is assignable/openable.
      scormEntryHref: "index.html",
      scormVersion: "1.2",
      scormUploadedAt: new Date(),
    },
  });
  return {
    course,
    cleanup: () =>
      prisma.course.delete({ where: { id: course.id } }).then(() => {}).catch((e) => console.warn("[e2e cleanup] delete failed, row may be leaked:", e instanceof Error ? e.message : e)),
  };
}

export async function seedRhdAttending(
  opts: { scheduleName?: string; fullName?: string } = {}
) {
  const t = tag();
  const attending = await prisma.rhdAttending.create({
    data: {
      scheduleName: opts.scheduleName ?? `E2E Attending ${t}`,
      fullName: opts.fullName ?? `E2E Attending ${t}`,
      isActive: true,
    },
  });
  return {
    attending,
    cleanup: () =>
      prisma.rhdAttending.delete({ where: { id: attending.id } }).then(() => {}).catch((e) => console.warn("[e2e cleanup] delete failed, row may be leaked:", e instanceof Error ? e.message : e)),
  };
}

/**
 * Temporarily sets `idealHeadcount` and/or `patientCapacityPerProvider` on a
 * department so the capacity panel renders in the builder. Restores the
 * previous values on cleanup, making the fixture safe against both bare-seed
 * CI (where the fields are null) and environments where they are already set.
 */
/**
 * Seed an uncleared volunteer: ACTIVE person with a @yale.edu contactEmail
 * (so dev login resolves them via the Yale-email step in resolvePersonForLogin)
 * and an ACTIVE VADM TermMembership. No phone, no HIPAA cert, no training, no
 * learning progress -- so the onboarding gate keeps them on /get-started.
 *
 * Person.status defaults to ACTIVE in the schema; no explicit field needed.
 */
export async function seedUnclearedVolunteer() {
  const t = tag();
  const term = await activeTerm();
  const department = await dept("VADM");
  const person = await prisma.person.create({
    data: { name: `E2E Uncleared ${t}`, contactEmail: `uncleared-${t}@yale.edu` },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: department.id, kind: "VOLUNTEER", status: "ACTIVE" },
  });
  return { person, cleanup: () => cleanupPerson(person.id) };
}

export async function seedCapacityConfig(
  deptCode: string,
  quota: { idealHeadcount?: number | null; patientCapacityPerProvider?: number | null }
) {
  const department = await prisma.department.findUniqueOrThrow({ where: { code: deptCode } });
  const before = {
    idealHeadcount: department.idealHeadcount,
    patientCapacityPerProvider: department.patientCapacityPerProvider,
  };
  await prisma.department.update({
    where: { id: department.id },
    data: {
      idealHeadcount: quota.idealHeadcount ?? null,
      patientCapacityPerProvider: quota.patientCapacityPerProvider ?? null,
    },
  });
  return {
    cleanup: async () => {
      await prisma.department.update({
        where: { id: department.id },
        data: { idealHeadcount: before.idealHeadcount, patientCapacityPerProvider: before.patientCapacityPerProvider },
      }).catch((e) => console.warn("[e2e cleanup] capacity reset failed:", e instanceof Error ? e.message : e));
    },
  };
}
