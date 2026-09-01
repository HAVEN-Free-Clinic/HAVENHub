/**
 * Imports one term's attending schedule from the Faculty Relations workbook.
 *
 * Each term is a sheet shaped like a wall calendar: a header row naming the
 * columns, then month name rows ("June") interleaved with day-of-month rows
 * ("6"), so a date is only resolvable by remembering the month above it.
 *
 * Two column quirks matter:
 *   - "Attending 9am-12pm" appears TWICE. Both feed the same slot, which is why
 *     a slot can carry several attendings.
 *   - "On-Call Attending" covers the week LEADING UP TO THE NEXT clinic day, so
 *     it is a property of the row, not one of the day's slots.
 *
 * Names in the cells are informal and inconsistent ("Peggy Bia", "Ami",
 * "Achong", "Dr. Silva"), so matching to the roster is best-effort and every
 * miss is REPORTED rather than guessed at. An imported schedule that quietly
 * named the wrong physician would be worse than one with gaps a human fills.
 */

import { prisma } from "@/platform/db";

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** Column headers that are not attending slots. */
const ON_CALL_HEADER = /on-?call/i;
const SPECIALTY_HEADER = /specialty\s*clinic/i;

/** A cell saying the clinic did not run, rather than naming anybody. */
const CLOSED = /closed/i;
/** A cell explicitly saying this column has nobody, which is not a miss. */
const NOT_APPLICABLE = /^n\/?a$/i;

export type ParsedScheduleRow = {
  /** ISO date key, e.g. "2026-06-06". */
  dateKey: string;
  /** Raw text of the on-call cell, unmatched. */
  onCallText: string | null;
  /** Raw text of the specialty clinic cell, unmatched. */
  specialtyText: string | null;
  /** Column header -> the raw name texts in it, in sheet order. */
  bySlotLabel: Record<string, string[]>;
};

export type ScheduleParse = {
  rows: ParsedScheduleRow[];
  /** Header text the parser did not recognise as a column, for a human. */
  unknownColumns: string[];
};

/**
 * Split a cell into the names it holds.
 *
 * The sheet writes "Peggy Bia/Frank Bia" when two people share one column, and
 * annotates with parentheses ("Ana (on call)") or an asterisk ("Achong*", a
 * first shift). Annotations are stripped for matching but the raw text is what
 * gets reported when a match fails, so nothing is silently reinterpreted.
 */
export function splitNames(text: string): string[] {
  // Checked BEFORE splitting: "N/A" is one token meaning nobody, and splitting
  // it on the slash first yields two bogus names, "N" and "A".
  if (NOT_APPLICABLE.test(text.trim())) return [];
  return text
    .split("/")
    .map((part) => part.replace(/\([^)]*\)/g, "").replace(/\*/g, "").trim())
    .filter((part) => part.length > 0 && !NOT_APPLICABLE.test(part));
}

/**
 * Read one term sheet.
 *
 * `year` is needed because the sheet writes only month names and day numbers,
 * and a term spans a year boundary (Fall 2026 runs October to January).
 */
export function parseTermSchedule(
  rows: unknown[][],
  opts: { startYear: number },
): ScheduleParse {
  const parse: ScheduleParse = { rows: [], unknownColumns: [] };
  if (rows.length === 0) return parse;

  // The header is the first row naming a recognisable column; sheets carry a
  // stray title row above it.
  const headerIndex = rows.findIndex((r) =>
    r.some((c) => typeof c === "string" && /attending|clinic/i.test(c)),
  );
  if (headerIndex < 0) return parse;
  const header = rows[headerIndex].map((c) => (c === null || c === undefined ? "" : String(c).trim()));

  let month = -1;
  let year = opts.startYear;

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    const first = row[0] === null || row[0] === undefined ? "" : String(row[0]).trim();
    if (!first) continue;

    const monthIndex = MONTHS.indexOf(first.toLowerCase());
    if (monthIndex >= 0) {
      // A term crossing New Year goes back to January with the year advanced.
      if (monthIndex < month) year += 1;
      month = monthIndex;
      continue;
    }

    const day = Number(first);
    if (!Number.isInteger(day) || day < 1 || day > 31 || month < 0) continue;

    const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const parsed: ParsedScheduleRow = {
      dateKey,
      onCallText: null,
      specialtyText: null,
      bySlotLabel: {},
    };

    for (let c = 1; c < header.length; c++) {
      const label = header[c];
      const raw = row[c] === null || row[c] === undefined ? "" : String(row[c]).trim();
      if (!raw) continue;

      // A closed marker describes the whole day and is not an attending name,
      // so it is still SKIPPED -- otherwise "(HAVEN FREE CLINIC CLOSED)" would
      // be read as a person in whatever column it sits in. It is no longer
      // recorded: closure is owned by admin.manage_terms and set in
      // Admin > Terms, never as a side effect of an import.
      if (CLOSED.test(raw)) continue;
      if (!label) continue;

      if (ON_CALL_HEADER.test(label)) {
        parsed.onCallText = raw;
        continue;
      }
      if (SPECIALTY_HEADER.test(label)) {
        parsed.specialtyText = raw;
        continue;
      }
      // Repeated headers (the sheet has two "Attending 9am-12pm" columns) feed
      // the same slot, which is exactly why a slot can carry several people.
      parsed.bySlotLabel[label] = [...(parsed.bySlotLabel[label] ?? []), raw];
    }

    parse.rows.push(parsed);
  }

  // Headers that name neither on-call, the specialty clinic, nor a slot column.
  const known = new Set<string>();
  for (const r of parse.rows) for (const label of Object.keys(r.bySlotLabel)) known.add(label);
  parse.unknownColumns = header
    .slice(1)
    .filter((h) => h && !ON_CALL_HEADER.test(h) && !SPECIALTY_HEADER.test(h) && !known.has(h));

  return parse;
}

/**
 * Map a sheet column header onto a clinic slot label.
 *
 * The sheet writes "Attending 9am-12pm" where the hub's column is "9am-12pm",
 * and "RHD Attending" / "BHD Clinic" / "Shadowing" match outright. Compared on
 * letters and digits only, so spacing and case drift do not break the link.
 */
export function normaliseLabel(text: string): string {
  return text.toLowerCase().replace(/attending/g, "").replace(/[^a-z0-9]/g, "");
}

export type ScheduleImportReport = {
  daysCreated: number;
  daysUpdated: number;
  assignmentsWritten: number;
  /**
   * Name text that matched no attending on the roster, with likely candidates.
   *
   * Suggestions are reported, never applied: "Steve Atlas" almost certainly means
   * Stephen Atlas, but acting on that guess is how a schedule ends up naming the
   * wrong physician. A human confirms by setting the attending's schedule name.
   */
  unmatchedNames: Array<{ dateKey: string; column: string; text: string; suggestions: string[] }>;
  /** Sheet columns with no matching clinic slot. */
  unmatchedColumns: string[];
  /** Specialty clinic text that matched no specialty. */
  unmatchedSpecialties: Array<{ dateKey: string; text: string }>;
  /** Date keys in the sheet that are not clinic dates of the term. */
  datesNotInTerm: string[];
};

/**
 * Write a parsed term schedule.
 *
 * Matching is deliberately strict: an attending is resolved by an exact,
 * case-insensitive schedule name, or by a unique surname match when the sheet
 * gives only a surname ("Finch", "Achong"). Anything ambiguous or unknown is
 * reported and left unassigned.
 */
export async function runTermScheduleImport(
  parse: ScheduleParse,
  opts: { termId: string; dryRun: boolean },
): Promise<ScheduleImportReport> {
  const report: ScheduleImportReport = {
    daysCreated: 0,
    daysUpdated: 0,
    assignmentsWritten: 0,
    unmatchedNames: [],
    unmatchedColumns: [],
    unmatchedSpecialties: [],
    datesNotInTerm: [],
  };

  const [term, roster, slots, specialties] = await Promise.all([
    prisma.term.findUniqueOrThrow({ where: { id: opts.termId }, select: { clinicDates: true } }),
    prisma.attending.findMany({ select: { id: true, scheduleName: true } }),
    prisma.clinicSlot.findMany({ select: { id: true, label: true, allowsMultiple: true } }),
    prisma.attendingSpecialty.findMany({ select: { id: true, code: true, name: true, runsSpecialtyClinic: true } }),
  ]);

  const dateByKey = new Map(term.clinicDates.map((d) => [d.toISOString().slice(0, 10), d]));
  const slotByNormalised = new Map(slots.map((s) => [normaliseLabel(s.label), s]));

  // Exact schedule name, plus surname and forename indexes for the sheet's
  // shorthand: it writes "Achong" and "Rath" (surnames) but also "Ami" and
  // "Ana" (forenames), depending on who is unambiguous around the clinic.
  const byExact = new Map(roster.map((a) => [a.scheduleName.toLowerCase(), a]));
  const bySurname = new Map<string, typeof roster>();
  const byForename = new Map<string, typeof roster>();
  for (const a of roster) {
    const parts = a.scheduleName.split(" ");
    const surname = parts[parts.length - 1]?.toLowerCase() ?? "";
    const forename = parts[0]?.toLowerCase() ?? "";
    bySurname.set(surname, [...(bySurname.get(surname) ?? []), a]);
    byForename.set(forename, [...(byForename.get(forename) ?? []), a]);
  }

  /**
   * An attending id, or null when the text is unknown or ambiguous.
   *
   * Only UNIQUE partial matches are accepted. Two attendings sharing a surname
   * (the sheet has several Bias) make that surname unusable, which is the point:
   * a schedule naming the wrong physician is worse than one with a gap a human
   * fills in.
   */
  function resolve(text: string): string | null {
    const cleaned = text.replace(/^dr\.?\s+/i, "").trim().toLowerCase();
    const exact = byExact.get(cleaned);
    if (exact) return exact.id;
    const bySur = bySurname.get(cleaned);
    if (bySur?.length === 1) return bySur[0].id;
    const byFore = byForename.get(cleaned);
    if (byFore?.length === 1) return byFore[0].id;
    return null;
  }

  /**
   * Roster names that SHARE A WORD with the unmatched text, so the report can
   * say "did you mean". Suggestions only -- never applied, because "Peggy Bia"
   * shares a surname with two people and picking one would be a coin toss.
   */
  function suggestionsFor(text: string): string[] {
    const words = new Set(
      text
        .replace(/^dr\.?\s+/i, "")
        .toLowerCase()
        .split(/[^a-z-]+/)
        .filter((w) => w.length > 2),
    );
    if (words.size === 0) return [];
    return roster
      .filter((a) => a.scheduleName.toLowerCase().split(/[^a-z-]+/).some((w) => words.has(w)))
      .map((a) => a.scheduleName)
      .sort();
  }

  for (const row of parse.rows) {
    const clinicDate = dateByKey.get(row.dateKey);
    if (!clinicDate) {
      report.datesNotInTerm.push(row.dateKey);
      continue;
    }

    const onCallId = row.onCallText ? resolve(row.onCallText) : null;
    if (row.onCallText && !onCallId) {
      report.unmatchedNames.push({
        dateKey: row.dateKey,
        column: "On call",
        text: row.onCallText,
        suggestions: suggestionsFor(row.onCallText),
      });
    }

    let specialtyId: string | null = null;
    if (row.specialtyText) {
      const text = row.specialtyText.toLowerCase();
      const match = specialties.find(
        (s) => s.runsSpecialtyClinic && (text.includes(s.name.toLowerCase()) || text.includes(s.code.toLowerCase())),
      );
      // The sheet abbreviates: "Derm", "Neuro", "Nephro".
      const prefix = specialties.find(
        (s) => s.runsSpecialtyClinic && text.includes(s.name.slice(0, 5).toLowerCase()),
      );
      specialtyId = match?.id ?? prefix?.id ?? null;
      if (!specialtyId) {
        report.unmatchedSpecialties.push({ dateKey: row.dateKey, text: row.specialtyText });
      }
    }

    // Resolve every cell before writing, so a row lands whole or not at all.
    const assignments: Array<{ slotId: string; attendingIds: string[] }> = [];
    for (const [label, texts] of Object.entries(row.bySlotLabel)) {
      const slot = slotByNormalised.get(normaliseLabel(label));
      if (!slot) {
        if (!report.unmatchedColumns.includes(label)) report.unmatchedColumns.push(label);
        continue;
      }
      const ids: string[] = [];
      for (const text of texts) {
        for (const name of splitNames(text)) {
          const id = resolve(name);
          if (!id) {
            report.unmatchedNames.push({
              dateKey: row.dateKey,
              column: label,
              text: name,
              suggestions: suggestionsFor(name),
            });
            continue;
          }
          if (!ids.includes(id)) ids.push(id);
        }
      }
      // Respect the column's own rule rather than writing rows the UI forbids.
      assignments.push({ slotId: slot.id, attendingIds: slot.allowsMultiple ? ids : ids.slice(0, 1) });
    }

    const existing = await prisma.clinicDay.findUnique({
      where: { termId_clinicDate: { termId: opts.termId, clinicDate } },
      select: { id: true },
    });
    existing ? report.daysUpdated++ : report.daysCreated++;
    report.assignmentsWritten += assignments.reduce((n, a) => n + a.attendingIds.length, 0);

    if (opts.dryRun) continue;

    await prisma.$transaction(async (tx) => {
      const day = await tx.clinicDay.upsert({
        where: { termId_clinicDate: { termId: opts.termId, clinicDate } },
        create: {
          termId: opts.termId,
          clinicDate,
          onCallAttendingId: onCallId,
          specialtyId,
        },
        update: {
          onCallAttendingId: onCallId,
          specialtyId,
        },
        select: { id: true },
      });

      for (const { slotId, attendingIds } of assignments) {
        // Replace-set per slot: the sheet is authoritative for this term.
        await tx.clinicDayAttending.deleteMany({ where: { clinicDayId: day.id, slotId } });
        if (attendingIds.length > 0) {
          await tx.clinicDayAttending.createMany({
            data: attendingIds.map((attendingId, order) => ({ clinicDayId: day.id, slotId, attendingId, order })),
          });
        }
      }
    });
  }

  return report;
}
