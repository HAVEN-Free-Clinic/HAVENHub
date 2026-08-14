/**
 * Imports the attending roster from the Faculty Relations contact sheet.
 *
 * The sheet is one table with three sections marked by header rows:
 *   <header>            current attendings
 *   "Removed:"          taken off the roster
 *   "Past Attendings:"  historical, name only
 *
 * Everything below "Removed:" lands INACTIVE rather than being skipped: the
 * roster is the record of who has ever attended, and a past attending still
 * appears on historical schedules.
 *
 * Parsing is separated from writing so the parse can be tested against the real
 * file without a database, and so a dry run reports exactly what an apply would
 * do.
 */

import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";

/** A row as the sheet holds it, before any database lookup. */
export type ParsedAttending = {
  /** Exactly as the sheet writes it, e.g. "Bia, Margaret" or "Madeline Wilson". */
  fullName: string;
  /** Derived "First Last", which is how the schedule sheet names people. */
  scheduleName: string;
  credentials: string | null;
  /** The sheet's specialty text, e.g. "Primary Care". Null when blank. */
  specialtyText: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  isActive: boolean;
};

export type RosterParse = {
  attendings: ParsedAttending[];
  /** Rows that could not be read, with the reason, for a human to look at. */
  skipped: Array<{ row: number; text: string; reason: string }>;
  /** Two rows deriving the same schedule name; neither is imported. */
  duplicateScheduleNames: Array<{ scheduleName: string; fullNames: string[] }>;
};

/** Section headers that switch the parser's mode, lowercased for matching. */
const REMOVED_HEADER = "removed";
const PAST_HEADER = "past attendings";

/**
 * "Last, First" or "First Last" -> the name the schedule sheet uses.
 *
 * A parenthetical given name wins: the contact sheet writes "Peng, Bo (Jack)"
 * and "Hughes, John (Jack)" while the schedule writes "Jack Peng" and "Jack
 * Hughes", so the nickname is what actually identifies them at the clinic.
 */
export function deriveScheduleName(fullName: string): string {
  const text = fullName.trim().replace(/\s+/g, " ");
  const [rawLast, rawFirst] = text.includes(",")
    ? text.split(",", 2).map((p) => p.trim())
    : [null, null];

  if (rawLast !== null && rawFirst) {
    return `${preferredGiven(rawFirst)} ${rawLast}`.trim();
  }

  // Already "First Last"; still honour a parenthetical nickname.
  const parts = text.split(" ");
  if (parts.length < 2) return text;
  const given = preferredGiven(parts.slice(0, -1).join(" "));
  return `${given} ${parts[parts.length - 1]}`.trim();
}

/** "Bo (Jack)" -> "Jack"; "Margaret" -> "Margaret". */
function preferredGiven(given: string): string {
  const nickname = given.match(/\(([^)]+)\)/);
  if (nickname) return nickname[1].trim();
  return given.trim();
}

/**
 * Attendings the schedule calls something the contact sheet cannot produce.
 *
 * Keyed by the contact sheet's name EXACTLY as written, so the mapping is
 * unambiguous about which person it means. These are everyday names with no
 * mechanical relationship to the formal one -- Margaret is Peggy, Stephen is
 * Steve -- so no derivation rule could find them; each was confirmed by Faculty
 * Relations rather than guessed.
 *
 * `Peggy Bia` is why the schedule import refuses to guess at all: the surname
 * alone is shared with Frank Bia, so an automatic match would have been a coin
 * toss between two real physicians.
 *
 * This list exists to make the FIRST import land correctly. Afterwards the
 * schedule name is editable per attending in the Hub, which is where an ongoing
 * change belongs.
 */
export const CONFIRMED_SCHEDULE_NAMES: Record<string, string> = {
  "Bia, Margaret": "Peggy Bia",
  "Atlas, Stephen": "Steve Atlas",
  "Kang, Angela": "Angi Kang",
  "Madeline Wilson": "Maddie Wilson",
  "Wormser, Andrew": "Andy Wormser",
  "Ponce Terashima, Javier": "Dr. Ponce",
};

function cell(row: unknown[], i: number): string | null {
  const v = row[i];
  if (v === null || v === undefined) return null;
  const text = String(v).trim();
  return text.length > 0 ? text : null;
}

/**
 * Read the contact sheet's rows into a plan.
 *
 * `rows` is the sheet as a rectangular array, header row included, exactly as a
 * spreadsheet reader hands it over. Column order is taken from the sheet's own
 * header rather than assumed, so inserting a column upstream does not silently
 * shift every field.
 */
export function parseAttendingRoster(rows: unknown[][]): RosterParse {
  const parse: RosterParse = { attendings: [], skipped: [], duplicateScheduleNames: [] };
  if (rows.length === 0) return parse;

  const header = rows[0].map((c) => String(c ?? "").trim().toLowerCase());
  const col = (needle: string) => header.findIndex((h) => h.includes(needle));
  const nameCol = 0;
  const credentialsCol = col("credential");
  const specialtyCol = col("specialty");
  const emailCol = col("email");
  const phoneCol = col("phone");
  const notesCol = col("note");

  let isActive = true;
  let inPastSection = false;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const first = cell(row, nameCol);
    if (!first) continue;

    const lower = first.toLowerCase();
    if (lower.startsWith(REMOVED_HEADER)) {
      isActive = false;
      continue;
    }
    if (lower.startsWith(PAST_HEADER)) {
      isActive = false;
      inPastSection = true;
      continue;
    }
    // The past section repeats a "Last Name | First Name" header of its own.
    if (inPastSection && lower === "last name") continue;

    // Past attendings are recorded as two columns rather than one full name.
    const fullName = inPastSection
      ? [first, cell(row, 1)].filter(Boolean).join(", ")
      : first;

    // A confirmed everyday name wins over the derived one: the schedule calls
    // Margaret Bia "Peggy", and no rule could derive that.
    const scheduleName = CONFIRMED_SCHEDULE_NAMES[fullName] ?? deriveScheduleName(fullName);
    if (!scheduleName) {
      parse.skipped.push({ row: i + 1, text: fullName, reason: "no readable name" });
      continue;
    }

    parse.attendings.push({
      fullName,
      scheduleName,
      credentials: inPastSection ? null : credentialsCol >= 0 ? cell(row, credentialsCol) : null,
      specialtyText: inPastSection ? null : specialtyCol >= 0 ? cell(row, specialtyCol) : null,
      email: inPastSection ? null : emailCol >= 0 ? cell(row, emailCol) : null,
      phone: inPastSection ? null : phoneCol >= 0 ? cell(row, phoneCol) : null,
      notes: inPastSection ? null : notesCol >= 0 ? cell(row, notesCol) : null,
      isActive,
    });
  }

  // scheduleName is unique in the database, so a collision has to be resolved by
  // a human rather than by the import picking a winner.
  const byScheduleName = new Map<string, string[]>();
  for (const a of parse.attendings) {
    byScheduleName.set(a.scheduleName, [...(byScheduleName.get(a.scheduleName) ?? []), a.fullName]);
  }
  const clashing = new Set<string>();
  for (const [scheduleName, fullNames] of byScheduleName) {
    if (fullNames.length > 1) {
      parse.duplicateScheduleNames.push({ scheduleName, fullNames });
      clashing.add(scheduleName);
    }
  }
  parse.attendings = parse.attendings.filter((a) => !clashing.has(a.scheduleName));

  return parse;
}

/**
 * The sheet's specialty wording, mapped to our specialty codes.
 *
 * Matched loosely (case-insensitive, "Nephrology Clinic" -> Nephrology) because
 * the sheet is maintained by hand. Anything unrecognised is reported rather than
 * guessed at: an attending filed under the wrong specialty would be asked the
 * wrong qualification questions.
 */
const SPECIALTY_ALIASES: Array<{ match: RegExp; code: string }> = [
  { match: /primary\s*care/i, code: "PC" },
  { match: /^rhd$|reproductive/i, code: "RHD" },
  { match: /^bhd$|behavioral/i, code: "BHD" },
  { match: /derma/i, code: "DERM" },
  { match: /neuro/i, code: "NEURO" },
  { match: /nephro/i, code: "NEPHRO" },
];

export function specialtyCodeFor(text: string | null): string | null {
  if (!text) return null;
  return SPECIALTY_ALIASES.find((a) => a.match.test(text))?.code ?? null;
}

export type RosterImportReport = {
  created: number;
  updated: number;
  unchanged: number;
  /** Specialty text the sheet uses that we could not map to a specialty. */
  unmappedSpecialties: Array<{ scheduleName: string; text: string }>;
  skipped: RosterParse["skipped"];
  duplicateScheduleNames: RosterParse["duplicateScheduleNames"];
};

/**
 * Write a parsed roster.
 *
 * Matches on `scheduleName`, which is the roster's unique key. An attending
 * already in the hub is UPDATED rather than duplicated, and never deleted: the
 * sheet is the source for who exists, not for who should be removed, and an
 * attending referenced by a historical schedule must survive a re-import.
 *
 * `dryRun` reports the same counts without writing.
 */
export async function runAttendingRosterImport(
  parse: RosterParse,
  opts: { dryRun: boolean; actorPersonId?: string },
): Promise<RosterImportReport> {
  const report: RosterImportReport = {
    created: 0,
    updated: 0,
    unchanged: 0,
    unmappedSpecialties: [],
    skipped: parse.skipped,
    duplicateScheduleNames: parse.duplicateScheduleNames,
  };

  const specialties = await prisma.attendingSpecialty.findMany({ select: { id: true, code: true } });
  const specialtyIdByCode = new Map(specialties.map((s) => [s.code, s.id]));

  for (const row of parse.attendings) {
    const code = specialtyCodeFor(row.specialtyText);
    if (row.specialtyText && !code) {
      report.unmappedSpecialties.push({ scheduleName: row.scheduleName, text: row.specialtyText });
    }
    const desired = {
      fullName: row.fullName,
      credentials: row.credentials,
      specialtyId: code ? specialtyIdByCode.get(code) ?? null : null,
      email: row.email,
      phone: row.phone,
      notes: row.notes,
      isActive: row.isActive,
    };

    const existing = await prisma.attending.findUnique({ where: { scheduleName: row.scheduleName } });
    if (!existing) {
      report.created++;
      if (!opts.dryRun) {
        await prisma.attending.create({ data: { scheduleName: row.scheduleName, ...desired } });
      }
      continue;
    }

    const changed =
      existing.fullName !== desired.fullName ||
      existing.credentials !== desired.credentials ||
      existing.specialtyId !== desired.specialtyId ||
      existing.email !== desired.email ||
      existing.phone !== desired.phone ||
      existing.notes !== desired.notes ||
      existing.isActive !== desired.isActive;

    if (!changed) {
      report.unchanged++;
      continue;
    }
    report.updated++;
    if (!opts.dryRun) {
      await prisma.attending.update({ where: { id: existing.id }, data: desired });
    }
  }

  if (!opts.dryRun && opts.actorPersonId) {
    await recordAudit({
      actorPersonId: opts.actorPersonId,
      action: "schedule.attending_roster_import",
      entityType: "Attending",
      entityId: "roster-import",
      after: {
        created: report.created,
        updated: report.updated,
        unchanged: report.unchanged,
      },
    });
  }

  return report;
}
