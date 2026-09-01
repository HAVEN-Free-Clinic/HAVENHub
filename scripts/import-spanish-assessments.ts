/**
 * Import of the historical Spanish assessment list (Spring 2012 onward).
 *
 * Handles both shapes the spreadsheet has used: the old email-keyed rows
 * (2012-2018) and the newer name-keyed rows (2019 on).
 *
 * The source file is prisma/seeds/spanish-assessments.xlsx, which is gitignored
 * because it is volunteer PII. Ask the interpreting directors for the current
 * export and drop it at that path before running.
 *
 * Run with: npx tsx scripts/import-spanish-assessments.ts
 *           npx tsx scripts/import-spanish-assessments.ts --dry-run
 *
 * Safe to re-run. It upserts: an imported row is keyed by (email|name, term) and
 * updated in place, and anything recorded in Hub since the last run is left
 * alone. The first version of this claimed the same thing in its docstring and
 * then opened with deleteMany({}), which wiped every assessment the review page
 * had recorded, every manual link, and every hand-added record.
 */

import * as XLSX from "xlsx";
import { PrismaClient, Prisma } from "@prisma/client";
import * as path from "path";
import * as fs from "fs";
import { normalizeTermLabel, termRankOf } from "../src/platform/languages/assessment-terms";

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes("--dry-run");

type ParsedRecord = {
  name: string | null;
  email: string | null;
  score: number | null;
  modifier: string | null;
  notes: string | null;
  term: string;
};

function parseScore(raw: unknown): { score: number | null; modifier: string | null } {
  if (raw === null || raw === undefined) return { score: null, modifier: null };
  const s = String(raw).trim();
  if (!s || ["nan", "none", "n/a", "na", "score"].includes(s.toLowerCase())) {
    return { score: null, modifier: null };
  }

  // "3.5" and "4.5": the assessors' way of writing a half step. Round toward the
  // nearer whole number and carry the direction as the modifier, so 3.5 reads as
  // "4-" rather than silently becoming a flat 4.
  const asFloat = Number.parseFloat(s);
  if (!Number.isNaN(asFloat) && !s.includes("+") && !s.includes("-")) {
    const rounded = Math.round(asFloat);
    const modifier = asFloat > rounded ? "plus" : asFloat < rounded ? "minus" : null;
    return { score: clampScore(rounded), modifier };
  }

  // "3+", "3-", "3+/4-": take the first alternative, which is the assessor's
  // primary call.
  const part = s.split("/")[0].trim();
  const match = part.match(/^(\d+)\s*([+-]?)\s*$/);
  if (match) {
    const modChar = match[2];
    return {
      score: clampScore(Number.parseInt(match[1], 10)),
      modifier: modChar === "+" ? "plus" : modChar === "-" ? "minus" : null,
    };
  }

  return { score: null, modifier: null };
}

/**
 * Scores outside 1-5 are out-of-scale entries, not zeroes to be rounded up. The
 * previous clamp turned a literal 0 into a 1, inventing "almost none" where the
 * assessor had written "did not attend".
 */
function clampScore(n: number): number | null {
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

function isTermHeader(first: string): boolean {
  return /^(Spring|Summer|Fall|Winter)\s+\d{4}$/i.test(first.trim());
}

function isHeaderRow(first: string): boolean {
  return first.trim().toLowerCase() === "name";
}

function isEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim());
}

function shouldSkip(row: unknown[]): boolean {
  const combined = row.slice(0, 6).map((c) => String(c ?? "").toLowerCase()).join(" ");
  return ["withdrew", "did not sign up", "withdrawn"].some((x) => combined.includes(x));
}

function parseWorkbook(filePath: string): ParsedRecord[] {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

  const records: ParsedRecord[] = [];
  let currentTerm = "Unknown";

  for (const row of rawRows) {
    const first = String(row[0] ?? "").trim();
    if (!first) continue;
    if (isTermHeader(first)) {
      currentTerm = normalizeTermLabel(first);
      continue;
    }
    if (isHeaderRow(first)) continue;
    if (shouldSkip(row)) continue;

    if (isEmail(first)) {
      // Old shape: email | score | notes
      const { score, modifier } = parseScore(row[1]);
      records.push({
        name: null,
        email: first.toLowerCase(),
        score,
        modifier,
        notes: row[2] ? String(row[2]).trim() : null,
        term: currentTerm,
      });
      continue;
    }

    // New shape: name | (numeric id OR score) | score | notes. When column 1
    // holds a long numeric id the score sits in column 2; otherwise column 1 IS
    // the score. The version this replaces wrote `test(col1) ? col2 : col2`,
    // both arms identical, so every row without an id column was read from the
    // wrong cell and imported with no score at all.
    const col1 = String(row[1] ?? "").trim();
    const col2 = String(row[2] ?? "").trim();
    const col3 = String(row[3] ?? "").trim();
    const hasIdColumn = /^\d{3,}$/.test(col1);
    const scoreCol = hasIdColumn ? col2 : col1;
    const notesCol = hasIdColumn ? col3 : col3 || col2;

    const { score, modifier } = parseScore(scoreCol);
    records.push({
      name: first,
      email: null,
      score,
      modifier,
      notes: notesCol || null,
      term: currentTerm,
    });
  }

  return records;
}

/**
 * Resolve each record to a Hub Person.
 *
 * Email rows match on contactEmail. Name rows match on Person.name, but ONLY
 * when exactly one ACTIVE-or-not person carries that name: two volunteers called
 * "Maria Garcia" must not have one of them silently handed the other's
 * assessment. Ambiguous and unmatched names import unlinked, for a reviewer to
 * resolve with the Link button on the history tab.
 */
async function resolvePeople(records: ParsedRecord[]): Promise<{
  byEmail: Map<string, string>;
  byName: Map<string, string>;
  ambiguousNames: Set<string>;
}> {
  const emails = [...new Set(records.map((r) => r.email).filter((e): e is string => Boolean(e)))];
  const names = [...new Set(records.map((r) => r.name).filter((n): n is string => Boolean(n)))];

  const [emailPeople, namePeople] = await Promise.all([
    emails.length
      ? prisma.person.findMany({
          where: { contactEmail: { in: emails, mode: "insensitive" } },
          select: { id: true, contactEmail: true },
        })
      : Promise.resolve([]),
    names.length
      ? prisma.person.findMany({
          where: { name: { in: names, mode: "insensitive" } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const byEmail = new Map<string, string>();
  for (const p of emailPeople) {
    if (p.contactEmail) byEmail.set(p.contactEmail.toLowerCase(), p.id);
  }

  const byName = new Map<string, string>();
  const ambiguousNames = new Set<string>();
  for (const p of namePeople) {
    const key = p.name.trim().toLowerCase();
    if (byName.has(key)) {
      ambiguousNames.add(key);
      byName.delete(key);
      continue;
    }
    if (!ambiguousNames.has(key)) byName.set(key, p.id);
  }

  return { byEmail, byName, ambiguousNames };
}

async function main() {
  const filePath = path.join(process.cwd(), "prisma/seeds/spanish-assessments.xlsx");
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    console.error("This file is gitignored (volunteer PII). Ask INTP for the current export.");
    process.exit(1);
  }

  const records = parseWorkbook(filePath);
  const unknownTerm = records.filter((r) => termRankOf(r.term) === 0);
  console.log(`Parsed ${records.length} records across terms.`);
  if (unknownTerm.length > 0) {
    console.warn(
      `  ${unknownTerm.length} carry an unrecognised term label and will sort last: ` +
        `${[...new Set(unknownTerm.map((r) => r.term))].join(", ")}`,
    );
  }

  const { byEmail, byName, ambiguousNames } = await resolvePeople(records);
  const linked = records.filter((r) =>
    r.email ? byEmail.has(r.email) : r.name ? byName.has(r.name.trim().toLowerCase()) : false,
  ).length;
  console.log(
    `Matched ${linked} of ${records.length} records to Hub persons ` +
      `(${byEmail.size} by email, ${byName.size} by unique name).`,
  );
  if (ambiguousNames.size > 0) {
    console.warn(
      `  ${ambiguousNames.size} names match more than one person and were left unlinked ` +
        "for manual resolution on the history tab.",
    );
  }

  if (DRY_RUN) {
    console.log("Dry run: nothing written.");
    await prisma.$disconnect();
    return;
  }

  let created = 0;
  let updated = 0;
  for (const r of records) {
    const personId = r.email
      ? (byEmail.get(r.email) ?? null)
      : r.name
        ? (byName.get(r.name.trim().toLowerCase()) ?? null)
        : null;

    const data = {
      email: r.email ?? "",
      name: r.name,
      score: r.score,
      modifier: r.modifier,
      notes: r.notes,
      term: r.term,
      termRank: termRankOf(r.term),
      personId,
    };

    // Linked rows key on the (personId, term) unique. Unlinked rows have no
    // unique to upsert against (personId is null and Postgres treats NULLs as
    // distinct), so they match on the identity the spreadsheet gave them.
    if (personId) {
      const existing = await prisma.spanishAssessmentRecord.findUnique({
        where: { personId_term: { personId, term: r.term } },
        select: { id: true },
      });
      await prisma.spanishAssessmentRecord.upsert({
        where: { personId_term: { personId, term: r.term } },
        create: data,
        // verified is decided in Hub by a reviewer, never by the import.
        update: {
          email: data.email,
          name: data.name,
          score: data.score,
          modifier: data.modifier,
          notes: data.notes,
          termRank: data.termRank,
        },
      });
      if (existing) updated += 1;
      else created += 1;
      continue;
    }

    const match = await prisma.spanishAssessmentRecord.findFirst({
      where: {
        personId: null,
        term: r.term,
        ...(r.email ? { email: r.email } : { name: r.name }),
      },
      select: { id: true },
    });
    if (match) {
      await prisma.spanishAssessmentRecord.update({
        where: { id: match.id },
        data: {
          score: data.score,
          modifier: data.modifier,
          notes: data.notes,
          termRank: data.termRank,
        },
      });
      updated += 1;
    } else {
      await prisma.spanishAssessmentRecord.create({ data });
      created += 1;
    }
  }

  console.log(`Done. ${created} created, ${updated} updated, 0 deleted.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    console.error(`Prisma error ${err.code}: ${err.message}`);
  } else {
    console.error(err);
  }
  await prisma.$disconnect();
  process.exit(1);
});
