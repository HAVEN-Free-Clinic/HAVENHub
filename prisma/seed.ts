// Dev fixture seed. Run via `npm run db:seed` (after `npm run db:migrate`; a stale Prisma client errors with P2011).
import { PrismaClient } from "@prisma/client";
// Canonical system-role grants live in one importable, side-effect-free module
// so the seed, the backfill migrations, and tests all share one source of truth.
import { SYSTEM_ROLES } from "../src/platform/rbac/system-roles";
// Canonical department names (authoritative). Upserted by code, names updated
// on every run. ITCM's name is intentionally "IT & Compliance Management".
// Lives in a side-effect-free module so tests can import the catalog without
// pulling in this file's top-level seed execution.
import { DEPARTMENTS } from "./department-catalog";

const prisma = new PrismaClient();

/**
 * Department delegation edges: a manager department oversees the managed ones.
 * Seeded idempotently and skipped silently when either code is missing.
 */
const DELEGATIONS: Array<{ manager: string; managed: string }> = [
  { manager: "PCAR", managed: "SCTP" },
  { manager: "PCAR", managed: "JCTP" },
  { manager: "VADC", managed: "VADM" },
  { manager: "SRHD", managed: "CCRH" },
  { manager: "SRHD", managed: "JCTS" },
  { manager: "SRHD", managed: "SCTS" },
];

/**
 * Every Saturday from start to end, inclusive.
 * Dates are anchored at 12:00 UTC so they remain "Saturday" when rendered in
 * any US timezone. Render clinic dates with timeZone: "UTC" regardless.
 */
function saturdays(startIso: string, endIso: string): Date[] {
  const out: Date[] = [];
  const end = new Date(`${endIso}T12:00:00Z`);
  for (
    let d = new Date(`${startIso}T12:00:00Z`);
    d <= end;
    d = new Date(d.getTime() + 7 * 86400000)
  ) {
    out.push(new Date(d));
  }
  return out;
}

/**
 * Assign a named role to each listed department code as a GLOBAL assignment
 * (termId null). Idempotent: skips when the assignment already exists.
 * Skips silently when the role or a department code is not found.
 */
async function assignGlobalToDepartments(roleName: string, codes: string[]) {
  const role = await prisma.role.findFirst({ where: { name: roleName } });
  if (!role) return;
  for (const code of codes) {
    const dept = await prisma.department.findFirst({ where: { code } });
    if (!dept) continue;
    const existing = await prisma.roleAssignment.findFirst({
      where: { roleId: role.id, departmentId: dept.id, termId: null },
    });
    if (!existing) {
      await prisma.roleAssignment.create({
        data: { roleId: role.id, departmentId: dept.id, termId: null },
      });
    }
  }
}

/**
 * Refuse to seed a non-local database unless explicitly allowed. The repo `.env`
 * points DATABASE_URL at the shared prod Neon instance, and this seed creates dev
 * fixtures (Dev Director/Volunteer people, verified HIPAA certs, ACTIVE memberships)
 * and force-activates a term -- running it against prod would corrupt real data.
 * Import/backfill scripts already gate on --apply; mirror that discipline here.
 */
function assertSafeToSeed(): void {
  let host = "";
  try {
    host = new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    host = "";
  }
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!isLocal && process.env.ALLOW_PROD_SEED !== "1") {
    throw new Error(
      `Refusing to seed a non-local database (host: ${host || "unknown"}). ` +
        `prisma/seed.ts writes dev fixtures and force-activates a term. ` +
        `Set ALLOW_PROD_SEED=1 to override.`,
    );
  }
}

async function main() {
  assertSafeToSeed();
  for (const dept of DEPARTMENTS) {
    await prisma.department.upsert({
      where: { code: dept.code },
      update: { name: dept.name, isActive: true },
      create: dept,
    });
  }

  // Deactivate the catch-all OTHER department (0 members). Upserted so a fresh
  // DB also lands it inactive.
  await prisma.department.upsert({
    where: { code: "OTHER" },
    update: { isActive: false },
    create: { code: "OTHER", name: "OTHER", isActive: false },
  });

  // Seed department delegations idempotently. Skip silently when either code is
  // missing (e.g. partial dev fixtures).
  for (const { manager, managed } of DELEGATIONS) {
    const managerDept = await prisma.department.findFirst({ where: { code: manager } });
    const managedDept = await prisma.department.findFirst({ where: { code: managed } });
    if (!managerDept || !managedDept) continue;
    await prisma.departmentDelegation.upsert({
      where: {
        managerDepartmentId_managedDepartmentId: {
          managerDepartmentId: managerDept.id,
          managedDepartmentId: managedDept.id,
        },
      },
      update: {},
      create: { managerDepartmentId: managerDept.id, managedDepartmentId: managedDept.id },
    });
  }

  for (const role of SYSTEM_ROLES) {
    const created = await prisma.role.upsert({
      where: { name: role.name },
      update: { description: role.description, isSystem: true },
      create: { name: role.name, description: role.description, isSystem: true },
    });
    // Grants are additive across re-runs; stale grants must be removed manually.
    for (const permission of role.grants) {
      await prisma.roleGrant.upsert({
        where: { roleId_permission: { roleId: created.id, permission } },
        update: {},
        create: { roleId: created.id, permission },
      });
    }
  }

  // Baseline access by membership kind. Replaces the engine's old hardcoded
  // auto-attach: a global kind-target assignment grants the Director/Volunteer
  // role to every active member of that kind, in any term. Idempotent.
  for (const [roleName, kind] of [
    ["Director", "DIRECTOR"],
    ["Volunteer", "VOLUNTEER"],
  ] as const) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) continue;
    const existing = await prisma.roleAssignment.findFirst({
      where: { roleId: role.id, kind, termId: null, personId: null, departmentId: null },
    });
    if (!existing) {
      await prisma.roleAssignment.create({ data: { roleId: role.id, kind, termId: null } });
    }
  }

  const su26 = await prisma.term.upsert({
    where: { code: "SU26" },
    // clinicDates/dates intentionally not re-upserted; reset the DB to change them.
    update: { status: "ACTIVE" },
    create: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-30T12:00:00Z"),
      endDate: new Date("2026-09-26T12:00:00Z"),
      status: "ACTIVE",
      clinicDates: saturdays("2026-05-30", "2026-09-26"), // 18 Saturdays
    },
  });

  const itcm = await prisma.department.findUniqueOrThrow({ where: { code: "ITCM" } });
  const vadm = await prisma.department.findUniqueOrThrow({ where: { code: "VADM" } });
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: "Platform Admin" } });

  // Dev people: a platform admin (your real email so Entra login also matches),
  // a director, and a volunteer.
  const jack = await prisma.person.upsert({
    where: { contactEmail: "j.carney@yale.edu" },
    update: {},
    create: { name: "Jack Carney", contactEmail: "j.carney@yale.edu" },
  });
  // Dev director and volunteer carry a phone so the onboarding "profile" task is
  // complete; paired with the verified HIPAA cert seeded below, they clear the
  // onboarding gate and are usable (loginable past /get-started) out of the box.
  const director = await prisma.person.upsert({
    where: { contactEmail: "dev.director@yale.edu" },
    update: { phone: "203-555-0131" },
    create: { name: "Dev Director", contactEmail: "dev.director@yale.edu", netId: "dd123", phone: "203-555-0131" },
  });
  const volunteer = await prisma.person.upsert({
    where: { contactEmail: "dev.volunteer@yale.edu" },
    update: { phone: "203-555-0142" },
    create: { name: "Dev Volunteer", contactEmail: "dev.volunteer@yale.edu", netId: "dv456", phone: "203-555-0142" },
  });
  // A support auditor: holds support.view_all_requests and nothing else, so the
  // e2e suite can prove the read-only grant really is read-only. Deliberately
  // NOT a SYSTEM_ROLE -- adding one would oblige a production backfill migration
  // for a role nobody has been granted yet, and the whole point of this
  // permission is that it is assigned by hand to the few people who need it.
  const auditor = await prisma.person.upsert({
    where: { contactEmail: "dev.support-auditor@yale.edu" },
    update: { phone: "203-555-0153" },
    create: {
      name: "Dev Support Auditor",
      contactEmail: "dev.support-auditor@yale.edu",
      netId: "dsa789",
      phone: "203-555-0153",
    },
  });
  const auditorRole = await prisma.role.upsert({
    where: { name: "IT Support Auditor" },
    update: { description: "Read-only view of every IT Support request" },
    create: { name: "IT Support Auditor", description: "Read-only view of every IT Support request" },
  });
  await prisma.roleGrant.upsert({
    where: { roleId_permission: { roleId: auditorRole.id, permission: "support.view_all_requests" } },
    update: {},
    create: { roleId: auditorRole.id, permission: "support.view_all_requests" },
  });

  const membership = (personId: string, departmentId: string, kind: "DIRECTOR" | "VOLUNTEER") =>
    prisma.termMembership.upsert({
      where: {
        personId_termId_departmentId_kind: {
          personId,
          termId: su26.id,
          departmentId,
          kind,
        },
      },
      update: { status: "ACTIVE" },
      create: { personId, termId: su26.id, departmentId, kind },
    });

  await membership(jack.id, itcm.id, "DIRECTOR");
  await membership(director.id, vadm.id, "DIRECTOR");
  await membership(volunteer.id, vadm.id, "VOLUNTEER");
  await membership(auditor.id, vadm.id, "VOLUNTEER");

  // A verified, currently-valid HIPAA cert clears the onboarding "hipaa" task for
  // the dev director and volunteer. Idempotent: skip if the person already has one.
  // (Jack is a Platform Admin and bypasses the gate via the exempt permission.)
  const ensureHipaaCert = async (personId: string) => {
    const existing = await prisma.hipaaCertificate.findFirst({ where: { personId } });
    if (existing) return;
    await prisma.hipaaCertificate.create({
      data: {
        personId,
        fileName: "seed-hipaa.pdf",
        storedName: `seed-${personId}.pdf`,
        size: 1024,
        mimeType: "application/pdf",
        completionDate: new Date(),
        verifiedAt: new Date(),
      },
    });
  };
  // Jack is exempt from the gate, but a cert gives his /my-info HIPAA panel a real
  // compliance status to display (matches what the production completion-date backfill produces).
  await ensureHipaaCert(jack.id);
  await ensureHipaaCert(director.id);
  await ensureHipaaCert(volunteer.id);
  await ensureHipaaCert(auditor.id);

  const existingAssignment = await prisma.roleAssignment.findFirst({
    where: { roleId: adminRole.id, personId: jack.id, termId: null },
  });
  if (!existingAssignment) {
    await prisma.roleAssignment.create({
      data: { roleId: adminRole.id, personId: jack.id, termId: null },
    });
  }

  const existingAuditorAssignment = await prisma.roleAssignment.findFirst({
    where: { roleId: auditorRole.id, personId: auditor.id, termId: null },
  });
  if (!existingAuditorAssignment) {
    await prisma.roleAssignment.create({
      data: { roleId: auditorRole.id, personId: auditor.id, termId: null },
    });
  }

  // GLOBAL (termId null) department assignments for clinic-wide roles.
  // Skip silently when the role or a department is missing.
  await assignGlobalToDepartments("Compliance Manager", ["EXEC", "SRR", "ITCM"]);
  await assignGlobalToDepartments("Volunteer Operations Manager", ["EXEC", "SRR", "ITCM"]);

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
