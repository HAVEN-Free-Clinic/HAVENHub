import type { Person } from "@prisma/client";
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
        const saved = await prisma.person.update({
          where: { id: existing.id },
          data: { ...fields, airtableRecordId },
        });
        importedByRecordId.set(airtableRecordId, saved.id);
        if (wasLinked) report.people.updated++;
        else report.people.linked++;
      } else {
        const saved = await prisma.person.create({ data: { ...fields, airtableRecordId } });
        importedByRecordId.set(airtableRecordId, saved.id);
        report.people.created++;
      }
    } catch (error) {
      report.people.skipped.push({
        recordId: person.airtableRecordId,
        reason: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
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

  const term = await prisma.term.upsert({
    where: { code: "SU26" },
    update: { status: "ACTIVE" },
    create: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-30T12:00:00Z"),
      endDate: new Date("2026-09-26T12:00:00Z"),
      status: "ACTIVE",
    },
  });

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
