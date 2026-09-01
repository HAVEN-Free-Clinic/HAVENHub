/**
 * One-time import script for historical Spanish assessment scores.
 * Handles both the old email-based format (2012-2018) and the newer
 * name-based format (2019 onward).
 *
 * Run with: npx tsx scripts/import-spanish-assessments.ts
 * Safe to re-run: upserts on (email, term) for email records, inserts
 * new records for name-only records (since there's no unique key).
 */

import * as XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";
import * as path from "path";
import * as fs from "fs";

const prisma = new PrismaClient();

type ParsedRecord = {
  name: string | null;
  email: string | null;
  score: number | null;
  modifier: string | null;
  notes: string | null;
  term: string;
};

function normalizeTerm(raw: string): string {
  const parts = raw.trim().split(/\s+/);
  if (parts.length === 2) {
    return parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase() + " " + parts[1];
  }
  return raw.trim();
}

function parseScore(raw: unknown): { score: number | null; modifier: string | null } {
  if (raw === null || raw === undefined) return { score: null, modifier: null };
  const s = String(raw).trim();
  if (!s || s.toLowerCase() === "nan" || s.toLowerCase() === "none" || s === "Score") {
    return { score: null, modifier: null };
  }

  // Handle float scores like 3.5, 4.5
  const asFloat = parseFloat(s);
  if (!isNaN(asFloat) && !s.includes("+") && !s.includes("-")) {
    const rounded = Math.round(asFloat);
    const modifier = asFloat > rounded ? "plus" : asFloat < rounded ? "minus" : null;
    return { score: Math.max(1, Math.min(5, rounded)), modifier };
  }

  // Handle string scores like 3+, 3-, 3+/4-
  const part = s.split("/")[0].trim();
  const match = part.match(/^(\d+)\s*([+-]?)\s*$/);
  if (match) {
    const score = parseInt(match[1], 10);
    const modChar = match[2];
    const modifier = modChar === "+" ? "plus" : modChar === "-" ? "minus" : null;
    return { score: Math.max(1, Math.min(5, score)), modifier };
  }

  return { score: null, modifier: null };
}

function isTermHeader(first: string): boolean {
  return /^(Spring|Summer|Fall|Winter)\s+\d{4}$/i.test(first.trim());
}

function isHeaderRow(first: string): boolean {
  return ["name", "name "].includes(first.trim().toLowerCase());
}

function isEmail(s: string): boolean {
  return s.includes("@") && s.includes(".");
}

function shouldSkip(row: unknown[]): boolean {
  const combined = row.slice(0, 6).map(c => String(c ?? "").toLowerCase()).join(" ");
  return ["withdrew", "did not sign up", "withdrawn"].some(x => combined.includes(x));
}

async function main() {
  const filePath = path.join(process.cwd(), "prisma/seeds/spanish-assessments.xlsx");
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

  const records: ParsedRecord[] = [];
  let currentTerm = "Unknown";

  for (const row of rawRows) {
    const first = String(row[0] ?? "").trim();
    if (!first) continue;
    if (isTermHeader(first)) { currentTerm = normalizeTerm(first); continue; }
    if (isHeaderRow(first)) continue;
    if (shouldSkip(row)) continue;

    if (isEmail(first)) {
      // Old format: email | raw_score | notes
      const { score, modifier } = parseScore(row[1]);
      records.push({
        name: null,
        email: first.toLowerCase(),
        score,
        modifier,
        notes: row[2] ? String(row[2]).trim() : null,
        term: currentTerm,
      });
    } else {
      // New format: name | (optional id or score) | score | proficiency/notes
      const col1 = String(row[1] ?? "").trim();
      const col2 = String(row[2] ?? "").trim();
      const col3 = String(row[3] ?? "").trim();

      // Score is in col2 if col1 looks like a numeric ID, else col2 directly
      const scoreCol = /^\d{3,}$/.test(col1) ? col2 : col2;
      const notesCol = /^\d{3,}$/.test(col1) ? col3 : col3 || col2;

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
  }

  console.log(`Parsed ${records.length} records across terms.`);

  // For email records, try to match to Person
  const emails = [...new Set(records.filter(r => r.email).map(r => r.email!))];
  const people = await prisma.person.findMany({
    where: { contactEmail: { in: emails, mode: "insensitive" } },
    select: { id: true, contactEmail: true },
  });
  const personByEmail = new Map(people.map(p => [p.contactEmail!.toLowerCase(), p.id]));
  console.log(`Matched ${personByEmail.size} of ${emails.length} emails to Hub persons.`);

  // Clear existing records and re-import fresh
  await prisma.spanishAssessmentRecord.deleteMany({});
  console.log("Cleared existing records.");

  let imported = 0;
  for (const r of records) {
    const personId = r.email ? (personByEmail.get(r.email) ?? null) : null;
    await prisma.spanishAssessmentRecord.create({
      data: {
        email: r.email ?? "",
        name: r.name,
        score: r.score,
        modifier: r.modifier,
        notes: r.notes,
        term: r.term,
        personId,
      },
    });
    imported++;
  }

  console.log(`Done. Imported ${imported} records.`);
  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });