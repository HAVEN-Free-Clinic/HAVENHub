/**
 * Writing the parsed board attendance grid into the hub.
 *
 * Everything the workbook implies gets written, in dependency order: the
 * ARCHIVED terms the old meetings need, Person rows for directors who served
 * before the hub existed, the DIRECTOR memberships that put those people on the
 * right department's roster for the right past term, the meetings themselves,
 * and finally the marks.
 *
 * This function always writes. A dry run is the caller running it inside a
 * transaction it then rolls back (see index.ts), which is the only way the plan
 * a human authorizes is the plan the real run executes: every unique index,
 * foreign key and enum check is exercised either way.
 *
 * Two rules govern re-runs. Attendance rows that already exist are left EXACTLY
 * as they are unless the caller asks for an overwrite, because by the time this
 * runs a second time an admin may have corrected an imported mark in the UI and
 * a blind upsert would silently undo that. And nothing is ever deleted: a
 * director dropped from the sheet is still a director who sat on that board.
 */

import type { Prisma, PrismaClient, BoardAttendanceStatus } from "@prisma/client";
import { recordAudit } from "@/platform/audit";
import type { SheetParse } from "./parse";
import { resolveBoardDepartmentCode } from "./departments";
import { buildPersonIndex, matchName, type NameMatch } from "./names";
import { HISTORICAL_TERMS, resolveTermForDate, type TermWindow } from "./terms";

type Db = PrismaClient | Prisma.TransactionClient;

export type BoardImportOptions = {
  /**
   * Rewrite attendance rows that already exist. Off by default so a re-run
   * cannot undo a human correction; turn it on when a mapping fix means the
   * previously imported value was wrong.
   */
  overwriteExisting: boolean;
};

export type BoardImportReport = {
  sheets: Array<{ sheet: string; rows: number; marks: number; meetings: number; emptyColumns: number }>;
  terms: { created: string[]; existing: string[] };
  meetings: { created: number; existing: number };
  people: {
    /** Sheet names that resolved to a Person already in the hub. */
    matched: number;
    /** Names created as OFFBOARDED people, because the hub never knew them. */
    created: string[];
    /** Names two people answer to. Their rows are skipped entirely. */
    ambiguous: string[];
    /** Sheet spellings rewritten by the alias table, for review before an apply. */
    aliased: Array<{ sheet: string; canonical: string }>;
  };
  memberships: {
    created: number;
    existing: number;
    /**
     * Memberships NOT written because their term is still live. The live
     * roster is owned by the roster import and gated on Person.status there;
     * writing into it from a spreadsheet would resurrect anyone who has since
     * been offboarded. Past terms carry no such risk, which is the whole
     * reason they are created ARCHIVED.
     */
    skippedLiveTerm: number;
  };
  attendance: { created: number; updated: number; unchanged: number; keptExisting: number };
  /** Department labels the mapping table does not know. No membership is written for them. */
  unmappedDepartments: string[];
  /** Meeting dates that fall outside every term window. Their marks are skipped. */
  unresolvedDates: string[];
  unreadableCells: Array<{ sheet: string; row: number; name: string; dateKey: string; text: string }>;
  /** One person marked two different ways for one meeting, and what was kept. */
  conflicts: Array<{ name: string; dateKey: string; kept: BoardAttendanceStatus; saw: string[] }>;
};

/**
 * Which mark survives when one person is marked twice for one meeting.
 *
 * This happens when a director appears on two rows, one per department they
 * ran, and whoever took attendance filled in only the row in front of them.
 * Presence wins: the director was demonstrably in the room, and ABSENT is the
 * value that feeds the strike count, so the ranking never manufactures one.
 */
const PRECEDENCE: Record<BoardAttendanceStatus, number> = { PRESENT: 3, EXCUSED: 2, ABSENT: 1 };

/** Noon UTC, matching BoardMeeting.meetingDate's documented convention. */
function meetingDateOf(dateKey: string): Date {
  return new Date(`${dateKey}T12:00:00Z`);
}

type PlannedMark = { status: BoardAttendanceStatus; note: string | null; seen: string[] };

export async function loadBoardAttendance(
  db: Db,
  sheets: SheetParse[],
  options: BoardImportOptions,
): Promise<BoardImportReport> {
  const report: BoardImportReport = {
    sheets: sheets.map((s) => ({
      sheet: s.sheet,
      rows: s.rows.length,
      marks: s.rows.reduce((n, r) => n + r.marks.length, 0),
      meetings: s.dateKeys.length,
      emptyColumns: s.emptyDateKeys.length,
    })),
    terms: { created: [], existing: [] },
    meetings: { created: 0, existing: 0 },
    people: { matched: 0, created: [], ambiguous: [], aliased: [] },
    memberships: { created: 0, existing: 0, skippedLiveTerm: 0 },
    attendance: { created: 0, updated: 0, unchanged: 0, keptExisting: 0 },
    unmappedDepartments: [],
    unresolvedDates: [],
    unreadableCells: sheets.flatMap((s) => s.unreadableCells.map((c) => ({ sheet: s.sheet, ...c }))),
    conflicts: [],
  };

  // ---- People -------------------------------------------------------------
  // Resolved first: the name is the join key for everything below, and an
  // ambiguous one has to drop out before it can reach a membership or a mark.
  const people = await db.person.findMany({ select: { id: true, name: true } });
  const index = buildPersonIndex(people);

  const sheetNames = [...new Set(sheets.flatMap((s) => s.rows.map((r) => r.name)))];
  const matches = new Map<string, NameMatch>(sheetNames.map((n) => [n, matchName(n, index)]));
  const personIdBySheetName = new Map<string, string>();
  const createdIdByName = new Map<string, string>();

  for (const [sheetName, match] of matches) {
    if (match.viaAlias === true) {
      report.people.aliased.push({ sheet: sheetName, canonical: match.canonicalName });
    }
    if (match.kind === "ambiguous") {
      report.people.ambiguous.push(sheetName);
      continue;
    }
    if (match.kind === "matched") {
      report.people.matched++;
      personIdBySheetName.set(sheetName, match.personId);
      continue;
    }
    // Two sheet spellings can canonicalize onto the same new person, so the
    // create is keyed on the canonical name rather than the sheet's.
    let id = createdIdByName.get(match.canonicalName);
    if (!id) {
      // OFFBOARDED, with no netId and no contactEmail: this is a record of who
      // served, not an account. Person.status is what every roster and login
      // path gates on, so a director from 2024 must never land ACTIVE here.
      const created = await db.person.create({
        data: { name: match.canonicalName, status: "OFFBOARDED" },
        select: { id: true },
      });
      id = created.id;
      createdIdByName.set(match.canonicalName, id);
      report.people.created.push(match.canonicalName);
    }
    personIdBySheetName.set(sheetName, id);
  }

  // ---- Terms --------------------------------------------------------------
  const existingTerms = await db.term.findMany({
    select: { id: true, code: true, status: true, startDate: true, endDate: true },
  });
  const existingByCode = new Map(existingTerms.map((t) => [t.code, t]));

  // Windows for resolution include the historical terms that do not exist yet,
  // so a date can be attributed before its term has been created.
  const windows: TermWindow[] = [
    ...existingTerms,
    ...HISTORICAL_TERMS.filter((spec) => !existingByCode.has(spec.code)).map((spec) => ({
      id: `pending:${spec.code}`,
      code: spec.code,
      startDate: spec.startDate,
      endDate: spec.endDate,
    })),
  ];

  const allDateKeys = [...new Set(sheets.flatMap((s) => s.dateKeys))].sort();
  const unresolved = new Set<string>();
  const neededCodes = new Set<string>();
  for (const dateKey of allDateKeys) {
    const window = resolveTermForDate(dateKey, windows);
    if (!window) {
      unresolved.add(dateKey);
      continue;
    }
    neededCodes.add(window.code);
  }

  // Only mint the historical terms the workbook actually reaches into, so a
  // workbook that stops in 2025 does not leave an empty SP24 behind.
  const termById = new Map<string, { id: string; code: string; archived: boolean }>();
  const termIdByCode = new Map<string, string>();
  for (const code of neededCodes) {
    const existing = existingByCode.get(code);
    if (existing) {
      report.terms.existing.push(code);
      termIdByCode.set(code, existing.id);
      termById.set(existing.id, { id: existing.id, code, archived: existing.status === "ARCHIVED" });
      continue;
    }
    const spec = HISTORICAL_TERMS.find((s) => s.code === code);
    if (!spec) continue;
    // ARCHIVED from birth and never activated: see terms.ts for why that is the
    // invariant the memberships below depend on.
    const created = await db.term.create({
      data: {
        code: spec.code,
        name: spec.name,
        startDate: spec.startDate,
        endDate: spec.endDate,
        status: "ARCHIVED",
      },
      select: { id: true },
    });
    report.terms.created.push(code);
    termIdByCode.set(code, created.id);
    termById.set(created.id, { id: created.id, code, archived: true });
  }
  report.terms.created.sort();
  report.terms.existing.sort();

  // ---- Departments --------------------------------------------------------
  const departments = await db.department.findMany({ select: { id: true, code: true } });
  const knownCodes = new Set(departments.map((d) => d.code));
  const departmentIdByCode = new Map(departments.map((d) => [d.code, d.id]));

  // ---- Fold the sheets into one plan --------------------------------------
  // Keyed by person and meeting date so the same director marked on two sheets,
  // or on two department rows of one sheet, collapses to a single mark.
  const marksByPersonDate = new Map<string, PlannedMark>();
  const membershipKeys = new Set<string>();
  const skippedLiveMembershipKeys = new Set<string>();
  const unmapped = new Set<string>();

  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      const personId = personIdBySheetName.get(row.name);
      if (!personId) continue;

      const departmentCode = resolveBoardDepartmentCode(row.departmentLabel, knownCodes);
      if (!departmentCode && row.departmentLabel !== "") unmapped.add(row.departmentLabel);
      const departmentId = departmentCode ? departmentIdByCode.get(departmentCode) : undefined;

      for (const mark of row.marks) {
        const window = resolveTermForDate(mark.dateKey, windows);
        const termId = window ? termIdByCode.get(window.code) : undefined;
        if (!termId) {
          unresolved.add(mark.dateKey);
          continue;
        }

        if (departmentId) {
          const membershipKey = `${personId}|${termId}|${departmentId}`;
          if (termById.get(termId)?.archived) membershipKeys.add(membershipKey);
          else skippedLiveMembershipKeys.add(membershipKey);
        }

        const key = `${personId}|${mark.dateKey}`;
        const existing = marksByPersonDate.get(key);
        if (!existing) {
          marksByPersonDate.set(key, { status: mark.status, note: mark.note, seen: [mark.raw] });
          continue;
        }
        existing.seen.push(mark.raw);
        if (PRECEDENCE[mark.status] > PRECEDENCE[existing.status]) {
          existing.status = mark.status;
          existing.note = mark.note;
        }
      }
    }
  }

  report.unmappedDepartments = [...unmapped].sort();
  report.unresolvedDates = [...unresolved].sort();
  report.memberships.skippedLiveTerm = skippedLiveMembershipKeys.size;

  const nameByPersonId = new Map<string, string>();
  for (const [sheetName, personId] of personIdBySheetName) {
    if (!nameByPersonId.has(personId)) nameByPersonId.set(personId, sheetName);
  }
  for (const [key, planned] of marksByPersonDate) {
    const distinct = [...new Set(planned.seen)];
    if (distinct.length < 2) continue;
    const separator = key.lastIndexOf("|");
    report.conflicts.push({
      name: nameByPersonId.get(key.slice(0, separator)) ?? key.slice(0, separator),
      dateKey: key.slice(separator + 1),
      kept: planned.status,
      saw: distinct,
    });
  }

  // ---- Memberships --------------------------------------------------------
  const plannedMemberships = [...membershipKeys].map((key) => {
    const [personId, termId, departmentId] = key.split("|");
    return { personId, termId, departmentId, kind: "DIRECTOR" as const, status: "ACTIVE" as const };
  });
  if (plannedMemberships.length > 0) {
    // skipDuplicates keys off the personId_termId_departmentId_kind unique
    // index, so a membership an admin has since marked REMOVED stays REMOVED.
    const { count } = await db.termMembership.createMany({
      data: plannedMemberships,
      skipDuplicates: true,
    });
    report.memberships.created = count;
    report.memberships.existing = plannedMemberships.length - count;
  }

  // ---- Meetings -----------------------------------------------------------
  const meetingIdByDate = new Map<string, string>();
  for (const dateKey of allDateKeys) {
    const window = resolveTermForDate(dateKey, windows);
    const termId = window ? termIdByCode.get(window.code) : undefined;
    if (!termId) continue;
    const meetingDate = meetingDateOf(dateKey);

    const existing = await db.boardMeeting.findUnique({
      where: { termId_meetingDate: { termId, meetingDate } },
      select: { id: true },
    });
    if (existing) {
      report.meetings.existing++;
      meetingIdByDate.set(dateKey, existing.id);
      continue;
    }
    const created = await db.boardMeeting.create({
      data: { termId, meetingDate },
      select: { id: true },
    });
    report.meetings.created++;
    meetingIdByDate.set(dateKey, created.id);
  }

  // ---- Attendance ---------------------------------------------------------
  const meetingIds = [...meetingIdByDate.values()];
  const existingAttendance = new Map<string, { id: string; status: BoardAttendanceStatus; note: string | null }>();
  if (meetingIds.length > 0) {
    for (const row of await db.boardMeetingAttendance.findMany({
      where: { meetingId: { in: meetingIds } },
      select: { id: true, meetingId: true, personId: true, status: true, note: true },
    })) {
      existingAttendance.set(`${row.meetingId}|${row.personId}`, {
        id: row.id,
        status: row.status,
        note: row.note,
      });
    }
  }

  const toCreate: Array<{ meetingId: string; personId: string; status: BoardAttendanceStatus; note: string | null }> = [];
  const toUpdate: Array<{ id: string; status: BoardAttendanceStatus; note: string | null }> = [];

  for (const [key, planned] of marksByPersonDate) {
    const separator = key.lastIndexOf("|");
    const personId = key.slice(0, separator);
    const meetingId = meetingIdByDate.get(key.slice(separator + 1));
    if (!meetingId) continue;

    const existing = existingAttendance.get(`${meetingId}|${personId}`);
    if (!existing) {
      report.attendance.created++;
      toCreate.push({ meetingId, personId, status: planned.status, note: planned.note });
      continue;
    }
    if (existing.status === planned.status && existing.note === planned.note) {
      report.attendance.unchanged++;
      continue;
    }
    if (!options.overwriteExisting) {
      report.attendance.keptExisting++;
      continue;
    }
    report.attendance.updated++;
    toUpdate.push({ id: existing.id, status: planned.status, note: planned.note });
  }

  if (toCreate.length > 0) {
    // recordedById stays null: nobody in the hub took this attendance, the
    // sheet did, and naming an operator here would put their id on thousands of
    // marks they never made.
    await db.boardMeetingAttendance.createMany({ data: toCreate, skipDuplicates: true });
  }
  for (const row of toUpdate) {
    await db.boardMeetingAttendance.update({
      where: { id: row.id },
      data: { status: row.status, note: row.note },
    });
  }

  await recordAudit(
    {
      actorPersonId: null,
      action: "board_meeting.import",
      entityType: "BoardMeeting",
      after: {
        sheets: report.sheets.map((s) => s.sheet),
        termsCreated: report.terms.created,
        meetings: report.meetings,
        attendance: report.attendance,
        peopleCreated: report.people.created.length,
      },
    },
    db,
  );

  return report;
}
