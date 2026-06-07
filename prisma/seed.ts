// Dev fixture seed. Run via `npm run db:seed` (after `npm run db:migrate`; a stale Prisma client errors with P2011).
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEPARTMENTS = [
  { code: "EXEC", name: "Executive Directors" },
  { code: "ITCM", name: "IT & Clinic Management" },
  { code: "SRR", name: "Staff Recruitment & Retention" },
  { code: "VADM", name: "Volunteer Administration" },
  { code: "VADC", name: "Volunteer Administration Directors" },
  { code: "PATS", name: "Patient Services" },
];

// Director/Volunteer are auto-attached by the RBAC engine via TermMembership.kind.
const SYSTEM_ROLES: Array<{ name: string; description: string; grants: string[] }> = [
  {
    name: "Platform Admin",
    description: "Full access to every module and admin function",
    grants: ["*"],
  },
  {
    name: "Director",
    description: "Baseline access for current-term directors",
    grants: ["schedule.view", "schedule.edit_own_dept", "volunteers.view", "my-info.access"],
  },
  {
    name: "Volunteer",
    description: "Baseline access for current-term volunteers",
    grants: ["schedule.view", "my-info.access"],
  },
  {
    name: "Compliance Manager",
    description: "Master compliance view across the clinic",
    grants: ["volunteers.view", "volunteers.manage_compliance"],
  },
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

async function main() {
  for (const dept of DEPARTMENTS) {
    await prisma.department.upsert({
      where: { code: dept.code },
      update: { name: dept.name },
      create: dept,
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
    create: { name: "Jack Carney", contactEmail: "j.carney@yale.edu", yaleEmail: "j.carney@yale.edu" },
  });
  const director = await prisma.person.upsert({
    where: { contactEmail: "dev.director@yale.edu" },
    update: {},
    create: { name: "Dev Director", contactEmail: "dev.director@yale.edu", netId: "dd123" },
  });
  const volunteer = await prisma.person.upsert({
    where: { contactEmail: "dev.volunteer@yale.edu" },
    update: {},
    create: { name: "Dev Volunteer", contactEmail: "dev.volunteer@yale.edu", netId: "dv456" },
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

  const existingAssignment = await prisma.roleAssignment.findFirst({
    where: { roleId: adminRole.id, personId: jack.id, termId: null },
  });
  if (!existingAssignment) {
    await prisma.roleAssignment.create({
      data: { roleId: adminRole.id, personId: jack.id, termId: null },
    });
  }

  // Compliance Manager role: GLOBAL (termId null) assignments to EXEC, SRR, ITCM
  // departments where they exist. Skip silently when absent.
  const complianceManagerRole = await prisma.role.findFirst({
    where: { name: "Compliance Manager" },
  });
  if (complianceManagerRole) {
    for (const code of ["EXEC", "SRR", "ITCM"]) {
      const dept = await prisma.department.findFirst({ where: { code } });
      if (!dept) continue;
      const existing = await prisma.roleAssignment.findFirst({
        where: { roleId: complianceManagerRole.id, departmentId: dept.id, termId: null },
      });
      if (!existing) {
        await prisma.roleAssignment.create({
          data: { roleId: complianceManagerRole.id, departmentId: dept.id, termId: null },
        });
      }
    }
  }

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
