import type { Person } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { transformPeople, transformRoster, type PersonImport } from "./transforms";

export type AirtableReader = {
  listAll(baseId: string, tableId: string): Promise<Array<{ id: string; fields: Record<string, unknown> }>>;
};

export type ImportOptions = {
  baseId: string;
  peopleTableId: string;
  rosterTableId: string;
  dryRun: boolean;
};

export type ImportReport = {
  dryRun: boolean;
  people: {
    created: number;
    updated: number;
    linked: number;
    skipped: Array<{ recordId: string; reason: string }>;
  };
  departments: number;
  memberships: number;
};

const insensitive = (value: string) => ({ equals: value, mode: "insensitive" as const });

async function findExisting(person: PersonImport): Promise<Person | null> {
  const byRecord = await prisma.person.findUnique({
    where: { airtableRecordId: person.airtableRecordId },
  });
  if (byRecord) return byRecord;
  if (person.netId) {
    const byNetId = await prisma.person.findFirst({ where: { netId: insensitive(person.netId) } });
    if (byNetId) return byNetId;
  }
  if (person.contactEmail) {
    return prisma.person.findFirst({ where: { contactEmail: insensitive(person.contactEmail) } });
  }
  return null;
}

export async function runImport(reader: AirtableReader, options: ImportOptions): Promise<ImportReport> {
  const report: ImportReport = {
    dryRun: options.dryRun,
    people: { created: 0, updated: 0, linked: 0, skipped: [] },
    departments: 0,
    memberships: 0,
  };

  const peopleRecords = await reader.listAll(options.baseId, options.peopleTableId);
  const rosterRecords = await reader.listAll(options.baseId, options.rosterTableId);
  const people = transformPeople(peopleRecords);
  const roster = transformRoster(rosterRecords);

  // Track identity collisions within the batch even in dry-run.
  const seenNetIds = new Set<string>();
  const seenEmails = new Set<string>();
  const seenPersonIds = new Set<string>();
  const importedByRecordId = new Map<string, string>(); // airtable rec id -> person id ("dry" in dry-run)

  for (const person of people) {
    if (person.netId && seenNetIds.has(person.netId)) {
      report.people.skipped.push({ recordId: person.airtableRecordId, reason: `duplicate netId ${person.netId}` });
      continue;
    }
    if (person.contactEmail && seenEmails.has(person.contactEmail)) {
      report.people.skipped.push({ recordId: person.airtableRecordId, reason: `duplicate email ${person.contactEmail}` });
      continue;
    }
    if (person.netId) seenNetIds.add(person.netId);
    if (person.contactEmail) seenEmails.add(person.contactEmail);

    try {
      const existing = await findExisting(person);

      // Resolved-identity guard: if two Airtable rows map to the same DB person,
      // skip the second rather than overwriting/duplicating it.
      if (existing && seenPersonIds.has(existing.id)) {
        report.people.skipped.push({
          recordId: person.airtableRecordId,
          reason: `resolves to person ${existing.id} already imported this run; merge the duplicate rows in Airtable`,
        });
        continue;
      }
      if (existing) seenPersonIds.add(existing.id);

      if (options.dryRun) {
        if (existing?.airtableRecordId === person.airtableRecordId) report.people.updated++;
        else if (existing) report.people.linked++;
        else report.people.created++;
        importedByRecordId.set(person.airtableRecordId, existing?.id ?? "dry");
        continue;
      }
      const { airtableRecordId, ...fields } = person;
      if (existing) {
        const wasLinked = existing.airtableRecordId === airtableRecordId;
        // Import never erases populated columns with blank Airtable cells; clearing happens through the app after cutover.
        const data: Record<string, unknown> = { airtableRecordId };
        for (const [key, value] of Object.entries(fields)) {
          if (value !== null) data[key] = value;
        }
        const saved = await prisma.person.update({ where: { id: existing.id }, data });
        importedByRecordId.set(airtableRecordId, saved.id);
        if (wasLinked) report.people.updated++;
        else report.people.linked++;
      } else {
        const saved = await prisma.person.create({ data: { ...fields, airtableRecordId } });
        importedByRecordId.set(airtableRecordId, saved.id);
        report.people.created++;
      }
    } catch (error) {
      const reason =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
          ? `unique constraint conflict on ${String((error.meta as { target?: unknown })?.target ?? "unknown field")}`
          : error instanceof Error
            ? error.message.slice(0, 200)
            : String(error);
      report.people.skipped.push({ recordId: person.airtableRecordId, reason });
    }
  }

  report.departments = roster.departments.length;
  report.memberships = roster.memberships.length;
  if (options.dryRun) return report;

  for (const dept of roster.departments) {
    await prisma.department.upsert({
      where: { code: dept.code },
      update: { name: dept.name },
      create: dept,
    });
  }

  // Ensure the SU26 term exists, but never force it ACTIVE on an idempotent
  // re-run. Forcing status here resurrected SU26 as a *second* ACTIVE term if
  // staff had since activated a later term (e.g. FA26) through /admin/terms,
  // breaking the single-active-term invariant that activateTerm maintains.
  // Instead create it in PLANNING and auto-activate only on a fresh cutover --
  // i.e. when no other term is already ACTIVE -- which preserves the original
  // "import sets up the active term" behavior without ever producing two.
  const term = await prisma.term.upsert({
    where: { code: "SU26" },
    update: {},
    create: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-30T12:00:00Z"),
      endDate: new Date("2026-09-26T12:00:00Z"),
      status: "PLANNING",
    },
  });

  if (term.status !== "ACTIVE") {
    const otherActive = await prisma.term.findFirst({
      where: { status: "ACTIVE", id: { not: term.id } },
    });
    // Only activate when nothing else is active; otherwise leave SU26 as-is so an
    // operator can swap to it deliberately through activateTerm.
    if (!otherActive) {
      await prisma.term.update({ where: { id: term.id }, data: { status: "ACTIVE" } });
    }
  }

  let membershipCount = 0;
  for (const membership of roster.memberships) {
    const personId = importedByRecordId.get(membership.personRecordId);
    if (!personId) continue; // linked record was skipped or not a person row
    const department = await prisma.department.findUniqueOrThrow({
      where: { code: membership.departmentCode },
    });
    await prisma.termMembership.upsert({
      where: {
        personId_termId_departmentId_kind: {
          personId,
          termId: term.id,
          departmentId: department.id,
          kind: membership.kind,
        },
      },
      update: { status: "ACTIVE" },
      create: { personId, termId: term.id, departmentId: department.id, kind: membership.kind },
    });
    membershipCount++;
  }
  report.memberships = membershipCount;
  return report;
}
