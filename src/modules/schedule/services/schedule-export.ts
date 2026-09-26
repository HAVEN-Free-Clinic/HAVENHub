/**
 * Spreadsheet export of one department's schedule for one term.
 *
 * One row per shift: the date, who, their role and tags, whether they are an RN,
 * and their Spanish score. Directors asked for it to sort, filter and print the
 * schedule in Excel; it is a hand-off, not a second editor.
 *
 * "New this term" is whether they came in on a NEW or TRANSFER application for
 * this term, the same mark the builder shows. It has to survive roster build:
 * once promoted, a first-timer's shifts are ordinary ShiftAssignments, and
 * directors schedule the term after that point, not before.
 *
 * Covers the whole board the builder shows, which is two tables:
 *   - ShiftAssignment, for everyone with a Person (members and returners);
 *   - IncomingShiftAssignment, for first-time applicants with no Person yet.
 *     Their RN answer and Spanish score are still on file, just in different
 *     places: the onboarding contract and the application's language assessment.
 *
 * Trusts its caller for permissions: the route gates on the same department
 * scope as the builder itself.
 */

import ExcelJS from "exceljs";
import { prisma } from "@/platform/db";
import { comparePersonName } from "@/platform/person-name";
import {
  NEWCOMER_COLUMNS,
  applicantCapabilities,
  liveAcceptanceWhere,
  newcomerOf,
  newcomersByMember,
  type Newcomer,
} from "@/platform/recruitment/incoming-roster";

const SPANISH = "es";

export type ScheduleExportRow = {
  clinicDate: Date;
  name: string;
  legalFirstName: string;
  lastName: string;
  role: "DIRECTOR" | "VOLUNTEER" | "SHADOW";
  tags: { triage: boolean; walkin: boolean; cc: boolean; remote: boolean; specialty: boolean };
  licensedRN: boolean;
  /** The assessed score, 1 to 5 in half steps. Null when nobody has scored them. */
  spanishScore: number | null;
  /** Null for a returning member (a renewal, or someone with no application). */
  newcomer: Newcomer | null;
};

const ROLE_ORDER = { DIRECTOR: 0, VOLUNTEER: 1, SHADOW: 2 } as const;
const ROLE_LABEL = { DIRECTOR: "Director", VOLUNTEER: "Volunteer", SHADOW: "Shadow" } as const;
const TAG_LABELS: [keyof ScheduleExportRow["tags"], string][] = [
  ["triage", "Triage"],
  ["walkin", "Walk-in"],
  ["cc", "CC"],
  ["remote", "Remote"],
  ["specialty", "Specialty"],
];

const TAG_SELECT = { triage: true, walkin: true, cc: true, remote: true, specialty: true } as const;

/**
 * Every shift on one (term, department) board, sorted by date, then role, then
 * surname.
 *
 * The Spanish score is any ASSESSED score, whatever the verdict: the export
 * reports the number, and a director reading it knows where the bar is. This is
 * deliberately wider than spanishScoresByPerson, which only returns scores
 * behind a "yes" because it feeds a capability badge.
 */
export async function loadScheduleExportRows(
  termId: string,
  departmentId: string,
): Promise<ScheduleExportRow[]> {
  const department = await prisma.department.findUniqueOrThrow({
    where: { id: departmentId },
    select: { code: true },
  });
  const [shifts, drafts] = await Promise.all([
    prisma.shiftAssignment.findMany({
      where: { termId, departmentId },
      select: {
        personId: true,
        clinicDate: true,
        role: true,
        ...TAG_SELECT,
        person: { select: { name: true, legalFirstName: true, lastName: true, licensedRN: true } },
      },
    }),
    prisma.incomingShiftAssignment.findMany({
      // Same predicate as the board: a withdrawn applicant's drafts are left in
      // place but are not on the schedule, and a promoted one's have moved.
      where: { termId, departmentId, acceptance: liveAcceptanceWhere() },
      select: {
        clinicDate: true,
        role: true,
        ...TAG_SELECT,
        acceptance: {
          select: {
            contract: { select: { licensedRN: true } },
            application: {
              select: {
                // A dual appointment's second acceptance has no contract of its
                // own; the one the person filled in hangs off the other.
                acceptances: { select: { contract: { select: { licensedRN: true } } } },
                ...NEWCOMER_COLUMNS,
                languageAssessments: {
                  where: { language: SPANISH, score: { not: null } },
                  select: { score: true },
                },
                applicant: {
                  select: {
                    firstName: true,
                    lastName: true,
                    applicantPerson: {
                      select: { id: true, name: true, legalFirstName: true, lastName: true, licensedRN: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  // A first-timer who already has a Person (an applicant account) may have been
  // scored there, so look them up alongside the members.
  const personIds = [
    ...new Set([
      ...shifts.map((s) => s.personId),
      ...drafts.flatMap((d) => d.acceptance.application.applicant.applicantPerson?.id ?? []),
    ]),
  ];
  const scoreRows =
    personIds.length === 0
      ? []
      : await prisma.personLanguage.findMany({
          where: {
            personId: { in: personIds },
            language: SPANISH,
            verifiedAt: { not: null },
            score: { not: null },
          },
          select: { personId: true, score: true },
        });
  const personScores = new Map(scoreRows.map((r) => [r.personId, r.score as number]));
  const newcomers = await newcomersByMember({
    termId,
    departmentCode: department.code,
    personIds: [...new Set(shifts.map((s) => s.personId))],
  });

  const rows: ScheduleExportRow[] = shifts.map((s) => ({
    clinicDate: s.clinicDate,
    name: s.person.name,
    legalFirstName: s.person.legalFirstName,
    lastName: s.person.lastName,
    role: s.role,
    tags: { triage: s.triage, walkin: s.walkin, cc: s.cc, remote: s.remote, specialty: s.specialty },
    licensedRN: s.person.licensedRN,
    spanishScore: personScores.get(s.personId) ?? null,
    // Keyed by membership kind, and a shadow shift is a volunteer's.
    newcomer: newcomers.get(`${s.personId}:${s.role === "DIRECTOR" ? "DIRECTOR" : "VOLUNTEER"}`) ?? null,
  }));

  for (const d of drafts) {
    const { application, contract } = d.acceptance;
    const { applicant } = application;
    const person = applicant.applicantPerson;
    const filledContract = contract ?? application.acceptances.find((a) => a.contract)?.contract ?? null;
    rows.push({
      clinicDate: d.clinicDate,
      name: person?.name ?? `${applicant.firstName} ${applicant.lastName}`.trim(),
      legalFirstName: person?.legalFirstName ?? applicant.firstName,
      lastName: person?.lastName ?? applicant.lastName,
      role: d.role,
      tags: { triage: d.triage, walkin: d.walkin, cc: d.cc, remote: d.remote, specialty: d.specialty },
      // Same rule as the builder's row. Languages are read below instead: the
      // export reports any assessed score, not only a verified one.
      licensedRN: applicantCapabilities({ person, contract: filledContract, assessments: [] }).licensedRN,
      spanishScore:
        (person ? personScores.get(person.id) : undefined) ??
        application.languageAssessments[0]?.score ??
        null,
      newcomer: newcomerOf(application),
    });
  }

  return rows.sort(
    (a, b) =>
      a.clinicDate.getTime() - b.clinicDate.getTime() ||
      ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
      comparePersonName(a, b),
  );
}

/** Tags as one readable cell, e.g. "Triage, Walk-in". Empty when there are none. */
export function tagsLabel(tags: ScheduleExportRow["tags"]): string {
  return TAG_LABELS.filter(([key]) => tags[key])
    .map(([, label]) => label)
    .join(", ");
}

/** "New", "Transfer from PCAR", or blank for a returning member. */
export function newcomerLabel(newcomer: Newcomer | null): string {
  if (!newcomer) return "";
  if (newcomer.type === "NEW") return "New";
  return newcomer.transferFrom.length > 0 ? `Transfer from ${newcomer.transferFrom.join(", ")}` : "Transfer";
}

/** The download's name, e.g. "RHD schedule FA26.xlsx". */
export function scheduleExportFilename(departmentCode: string, termCode: string): string {
  return `${departmentCode} schedule ${termCode}.xlsx`;
}

/**
 * The rows as an .xlsx workbook: one sheet, a bold frozen header, and real date
 * cells so Excel sorts and filters them as dates rather than text.
 */
export async function buildScheduleWorkbook(rows: ScheduleExportRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Schedule", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Date", key: "date", width: 14, style: { numFmt: "ddd m/d/yyyy" } },
    { header: "Name", key: "name", width: 28 },
    { header: "Role", key: "role", width: 12 },
    { header: "Tags", key: "tags", width: 22 },
    { header: "RN", key: "rn", width: 6 },
    { header: "Spanish score", key: "spanish", width: 14 },
    { header: "New this term", key: "newcomer", width: 20 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: "A1", to: "G1" };

  for (const r of rows) {
    ws.addRow({
      // Clinic dates are anchored at 12:00 UTC and ExcelJS writes dates as UTC,
      // so the cell lands on the right calendar day in every time zone.
      date: r.clinicDate,
      name: r.name,
      role: ROLE_LABEL[r.role],
      tags: tagsLabel(r.tags),
      rn: r.licensedRN ? "Yes" : "",
      spanish: r.spanishScore,
      newcomer: newcomerLabel(r.newcomer),
    });
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
