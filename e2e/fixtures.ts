import { PrismaClient, type HistoricalOutcome, type HistoricalStage, type Track } from "@prisma/client";
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
  // ShiftRequest has no personId: a person appears as requesterId (cascades), targetId
  // (SetNull), or decidedById (Restrict). Clear requester/target rows explicitly so
  // cleanup is deterministic; fixture members never decide requests, so decidedById is moot.
  await prisma.shiftRequest.deleteMany({ where: { OR: [{ requesterId: personId }, { targetId: personId }] } });
  await prisma.shiftAssignment.deleteMany({ where: { personId } });
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

/**
 * A PLANNING term far enough in the future to win getNextTerm's
 * `orderBy: { startDate: "desc" }`, so the transition report resolves to THIS
 * term even on a dev database that already has one in planning.
 */
export async function seedPlanningTerm(code: string) {
  const term = await prisma.term.create({
    data: {
      code,
      name: `E2E Planning ${code}`,
      startDate: new Date("2099-01-01"),
      endDate: new Date("2099-05-01"),
      status: "PLANNING",
    },
  });
  return {
    term,
    cleanup: async () => {
      await prisma.termMembership.deleteMany({ where: { termId: term.id } });
      await prisma.offboardFlag.deleteMany({ where: { termId: term.id } });
      await prisma.term.delete({ where: { id: term.id } }).catch((e) =>
        console.warn("[e2e cleanup] term delete failed, row may be leaked:", e instanceof Error ? e.message : e),
      );
    },
  };
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
  opts: { title?: string; deptCode?: string } = {}
) {
  const t = tag();
  // Scope to one department (not assignToAll). An org-wide packaged course is
  // auto-assigned to every member (coursesForMember), which would briefly gate
  // dev.volunteer/dev.director on the onboarding learning task and flake the
  // login-based specs. The admin (Jack, ITCM director) is still assigned via the dept.
  const department = await dept(opts.deptCode ?? "ITCM");
  const course = await prisma.course.create({
    data: {
      title: opts.title ?? `E2E Course ${t}`,
      isActive: true,
      assignToAll: false,
      // Marks the course as having an ingested package so it is assignable/openable.
      scormEntryHref: "index.html",
      scormVersion: "1.2",
      scormUploadedAt: new Date(),
      departments: { create: [{ departmentId: department.id }] },
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
  // Attendings belong to a SERVICE LINE, identified by its managing department
  // (SRHD for reproductive health). The seed creates SRHD and its delegations,
  // so this resolves in any environment the e2e suite runs against.
  const serviceLine = await prisma.department.findUniqueOrThrow({ where: { code: "SRHD" } });
  const attending = await prisma.rhdAttending.create({
    data: {
      scheduleName: opts.scheduleName ?? `E2E Attending ${t}`,
      fullName: opts.fullName ?? `E2E Attending ${t}`,
      departmentId: serviceLine.id,
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
 * An ACTIVE Person with a term membership but no phone and no HIPAA cert, so
 * the onboarding gate holds them at /get-started.
 *
 * deptCode defaults to VADM. Pass a department with no seeded dev users (e.g.
 * FOOD) when the test also seeds a course there: a department-scoped course is
 * assigned to every member of that department, and VADM is where dev.volunteer
 * and dev.director live, so a VADM course would transiently gate them too.
 *
 * A Volunteer RoleAssignment is created explicitly. It is redundant with the
 * kind-scoped assignment prisma/seed.ts seeds (kind VOLUNTEER, personId null),
 * which already grants learning.access to any active-term VOLUNTEER membership;
 * it is kept so the fixture does not silently depend on that seed row.
 * It cascades with the person, so cleanupPerson needs no change.
 */
export async function seedUnclearedVolunteer(opts: { deptCode?: string } = {}) {
  const t = tag();
  const term = await activeTerm();
  const department = await dept(opts.deptCode ?? "VADM");
  const person = await prisma.person.create({
    data: { name: `E2E Uncleared ${t}`, contactEmail: `uncleared-${t}@yale.edu` },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: department.id, kind: "VOLUNTEER", status: "ACTIVE" },
  });
  const volunteerRole = await prisma.role.findFirstOrThrow({ where: { name: "Volunteer" } });
  await prisma.roleAssignment.create({
    data: { roleId: volunteerRole.id, personId: person.id, termId: term.id },
  });
  return { person, cleanup: () => cleanupPerson(person.id) };
}

/**
 * Seed an ACTIVE Person with a non-Yale contactEmail, for the member
 * magic-link sign-in e2e. requestMemberLoginLink resolves member accounts by
 * an ACTIVE Person's contactEmail (and refuses a @yale.edu address before
 * ever looking one up), so this needs no TermMembership: without an
 * active-term membership the onboarding gate's hasActiveTerm check is false
 * and a freshly signed-in member lands straight on the hub instead of
 * /get-started, which keeps this fixture focused on the sign-in flow alone.
 */
export async function seedActiveMember(opts: { name?: string } = {}) {
  const t = tag();
  const person = await prisma.person.create({
    data: {
      name: opts.name ?? `E2E Member ${t}`,
      contactEmail: `e2e-member-${t}@example.org`,
      status: "ACTIVE",
    },
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

/**
 * Seeds a HistoricalApplicant (+ one known email) from the Airtable-import
 * history tables, optionally with a single prior-cycle HistoricalApplication,
 * for the recruitment-history e2e coverage. Deleting the applicant cascades to
 * its emails and applications (see the onDelete: Cascade relations in
 * prisma/schema.prisma), so cleanup is a single delete.
 *
 * The email is stored lowercased: getApplicantHistory matches archive rows by
 * lower-casing whatever email it is given, and matching "goes through the
 * emails relation, never [primaryEmail]" per the model's own doc comment, so
 * this mirrors what a real import produces.
 */
export async function seedHistoricalApplicant(opts: {
  email: string;
  firstName?: string;
  lastName?: string;
  netId?: string;
  application?: {
    cycleLabel: string;
    cycleCode?: string;
    track?: Track;
    departmentChoices?: string[];
    furthestStage?: HistoricalStage;
    outcome?: HistoricalOutcome;
    submittedAt?: Date;
  };
}) {
  const t = tag();
  const emailLower = opts.email.trim().toLowerCase();
  const application = opts.application;
  const applicant = await prisma.historicalApplicant.create({
    data: {
      firstName: opts.firstName ?? "E2E",
      lastName: opts.lastName ?? `History ${t}`,
      primaryEmail: emailLower,
      netId: opts.netId ?? null,
      emails: { create: [{ email: emailLower }] },
      ...(application
        ? {
            applications: {
              create: [
                {
                  sourceBaseId: "e2e",
                  sourceTableId: "e2e",
                  sourceRecordId: t,
                  cycleCode: application.cycleCode ?? `E2E-${t}`,
                  cycleLabel: application.cycleLabel,
                  track: application.track ?? "VOLUNTEER",
                  departmentChoices: application.departmentChoices ?? [],
                  furthestStage: application.furthestStage ?? "APPLIED",
                  outcome: application.outcome ?? "NO_DECISION",
                  submittedAt: application.submittedAt ?? new Date("2023-09-01T00:00:00Z"),
                },
              ],
            },
          }
        : {}),
    },
  });
  return {
    applicant,
    cleanup: () =>
      prisma.historicalApplicant
        .delete({ where: { id: applicant.id } })
        .then(() => {})
        .catch((e) => console.warn("[e2e cleanup] delete failed, row may be leaked:", e instanceof Error ? e.message : e)),
  };
}

// ---------------------------------------------------------------------------
// Clinic check-in fixtures
// ---------------------------------------------------------------------------

/** The app's configured display zone, mirroring getDisplayTimeZone's default
 *  (a bare seed never writes this Setting row, so it falls back the same way
 *  config.DISPLAY_TIME_ZONE does). Read directly rather than importing the
 *  Next-only settings service into this standalone Prisma client. */
async function resolveDisplayZone(): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key: "display.timeZone" } });
  return typeof row?.value === "string" && row.value.trim() ? row.value : "America/New_York";
}

/** Calendar day (YYYY-MM-DD) of `date` as it reads in `zone`. */
function ymdInZone(date: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** UTC calendar day of a noon-UTC-anchored clinic date, matching isoDateKey. */
function isoDateKeyUTC(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Ensures "today" (the app's display-zone calendar day) is one of the active
 * term's clinic dates. Check-in, attendance, and the dashboard's clinic-today
 * card all gate on todaysClinicDate matching an entry in Term.clinicDates,
 * and the seeded term's dates are a fixed range (or, on a bare-migrated DB,
 * empty), so most days this needs a temporary date added to make check-in
 * e2e-testable at all.
 *
 * Idempotent and non-destructive: when today already IS a seeded clinic date,
 * this is a no-op and cleanup does nothing, so it never clobbers a real date.
 */
export async function seedTodayClinicDate() {
  const term = await activeTerm();
  const zone = await resolveDisplayZone();
  const todayKey = ymdInZone(new Date(), zone);
  const existing = term.clinicDates.find((d) => isoDateKeyUTC(d) === todayKey);
  const clinicDate = existing ?? new Date(`${todayKey}T12:00:00Z`);

  if (!existing) {
    await prisma.term.update({
      where: { id: term.id },
      data: { clinicDates: [...term.clinicDates, clinicDate] },
    });
  }

  return {
    termId: term.id,
    clinicDate,
    todayKey,
    cleanup: async () => {
      if (existing) return;
      await prisma.term
        .update({ where: { id: term.id }, data: { clinicDates: term.clinicDates } })
        .catch((e) => console.warn("[e2e cleanup] clinicDates restore failed:", e instanceof Error ? e.message : e));
    },
  };
}

/**
 * An onboarded (gate-cleared), ACTIVE VOLUNTEER: phone set (clears the
 * "profile" onboarding task) and a verified, currently-valid HIPAA cert
 * (clears "hipaa"). A bare-seeded department has no Course, EhsTraining, or
 * isTermTraining RecruitmentCycle rows, so training/learning/ehs all resolve
 * NOT_REQUIRED -- these two are the only tasks that matter. Passes
 * enforceOnboarding, so this person can sign themselves in via the dev-login
 * credentials flow and reach any gated (app) route, not just be the *target*
 * of another session's action (unlike seedComplianceMember, which never signs
 * in as itself).
 *
 * The dev-login credentials provider only matches a person by a
 * Yale-asserted email claim (see matchPersonByClaim step 3), so the
 * contactEmail here MUST be @yale.edu or sign-in silently fails to match
 * anyone.
 *
 * Pass `assignment` to also seed a ShiftAssignment for this person, which is
 * what getCheckInState/fullSchedule use to treat them as scheduled today.
 */
export async function seedOnboardedVolunteer(
  deptCode: string,
  opts: {
    assignment?: { clinicDate: Date; role?: "VOLUNTEER" | "DIRECTOR"; remote?: boolean };
  } = {}
) {
  const term = await activeTerm();
  const department = await dept(deptCode);
  const t = tag();
  const email = `e2e-checkin-${t}@yale.edu`;
  const person = await prisma.person.create({
    data: {
      name: `E2E Volunteer ${t}`,
      contactEmail: email,
      phone: "203-555-0199",
    },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: department.id, kind: "VOLUNTEER", status: "ACTIVE" },
  });
  await prisma.hipaaCertificate.create({
    data: {
      personId: person.id,
      fileName: "e2e.pdf",
      storedName: `${t}.pdf`,
      size: 100,
      mimeType: "application/pdf",
      completionDate: daysFromNow(-10),
      verifiedAt: new Date(),
    },
  });
  if (opts.assignment) {
    await prisma.shiftAssignment.create({
      data: {
        termId: term.id,
        departmentId: department.id,
        personId: person.id,
        clinicDate: opts.assignment.clinicDate,
        role: opts.assignment.role ?? "VOLUNTEER",
        remote: opts.assignment.remote ?? false,
      },
    });
  }
  return { person, email, cleanup: () => cleanupPerson(person.id) };
}

/**
 * Records a director-recorded (STAFF-method) attendance row directly, for
 * tests that need a person to already be "Here" without exercising the
 * check-in flow itself. Cascades away with the person; no separate cleanup.
 */
export async function seedAttendance(termId: string, clinicDate: Date, personId: string) {
  return prisma.clinicAttendance.create({
    data: { termId, clinicDate, personId, method: "STAFF" },
  });
}
