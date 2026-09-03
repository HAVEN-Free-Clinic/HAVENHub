# Language Score Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every volunteer a Spanish proficiency score instead of only active interpreting-department members, and turn the imported historical assessment list into real badges.

**Architecture:** Three independent changes, no schema migration. A new testable backfill module writes `PersonLanguage` from the most recent scored `SpanishAssessmentRecord` for active people. The review queue stops branching on INTP membership, so every claim gets a score field. The roster badge gains an `ES+` tier at score 5.

**Tech Stack:** Next.js App Router (server components, server actions), Prisma on Postgres, Vitest against a real test database, `tsx` for scripts.

**Spec:** `docs/superpowers/specs/2026-09-03-language-score-unification-design.md`

## Global Constraints

- **No em-dashes anywhere.** CI enforces the `local/no-em-dash` ESLint rule and lint runs before tests. Use "--" or restructure the sentence.
- **No schema change.** `PersonLanguage.score`, `SpanishAssessmentRecord`, and `Department.minInterpreterScore` all already exist. Do not write a migration.
- **`catalog.ts` must stay client-safe.** It is imported by client components. Never add an import of `prisma`, `notify`, or the email renderer to it. Database code belongs in `index.ts` or a sibling module.
- **The 1-5 score is INTERNAL.** It renders on staff-gated pages only. Nothing in this plan may surface it on `/my-info`.
- **Verification before completion:** run `npx vitest run src/platform` (platform guard tests fire from anywhere) and `npx eslint src e2e` before the final commit of each task. Typecheck and unit tests alone do not cover the ESLint module-boundary rules.
- **Test database:** tests use the real Postgres test DB via `resetDb()` from `@/platform/test/db`. `TEST_DATABASE_URL` is per-worktree; if the suite cannot connect, that is environment setup, not a code failure.

---

### Task 1: Badge backfill from the assessment history

**Files:**
- Modify: `src/platform/languages/catalog.ts` (add one constant)
- Create: `src/platform/languages/badge-backfill.ts`
- Create: `src/platform/languages/badge-backfill.test.ts`
- Create: `scripts/backfill-language-badges.ts`
- Modify: `package.json` (two script entries, after the existing `backfill:languages:*` pair around line 38)

**Interfaces:**
- Consumes: `SPANISH` and `LanguageValidationError` from `./catalog`; `termRankOf` from `./assessment-terms`; `prisma` from `@/platform/db`.
- Produces:
  - `SPANISH_SPEAKER_MIN_SCORE = 3` exported from `./catalog`. Task 3 does **not** use this; it uses its own constant.
  - `backfillLanguageBadges(opts: { dryRun: boolean }): Promise<BadgeBackfillReport>` from `./badge-backfill`.
  - `type BadgeBackfillOutcome = "badged" | "settled" | "score-filled" | "unchanged" | "no-score"`
  - `type BadgeBackfillRow = { personId: string; name: string; outcome: BadgeBackfillOutcome; score: number | null; term: string | null }`
  - `type BadgeBackfillReport = { rows: BadgeBackfillRow[]; counts: Record<BadgeBackfillOutcome, number>; unlinkedRecords: number }`

Why the logic lives in `src/platform/` and not in the script: nothing under `scripts/` has a test in this repo. `spanish-assessments.ts` was extracted from the review page's server actions for exactly this reason, and its own docstring records that being inline "meant none of it could be tested."

- [ ] **Step 1: Add the badge floor constant to the catalog**

In `src/platform/languages/catalog.ts`, immediately after the existing `CLINIC_WIDE_INTERPRETER_MIN_SCORE` block, add:

```ts
/**
 * The score at which an assessment produces a verified Spanish badge.
 *
 * Lower than CLINIC_WIDE_INTERPRETER_MIN_SCORE on purpose. A 3 is
 * conversational: the person genuinely speaks Spanish with patients, and
 * whether that is enough to interpret is each department's call through
 * Department.minInterpreterScore. Reading the interpreting bar as the badge
 * floor would hide conversational speakers from the departments documented as
 * staffing them.
 *
 * 1 and 2 are assessments too, and settle the question rather than badging it.
 */
export const SPANISH_SPEAKER_MIN_SCORE = 3;
```

- [ ] **Step 2: Write the failing tests**

Create `src/platform/languages/badge-backfill.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { termRankOf } from "./assessment-terms";
import { backfillLanguageBadges } from "./badge-backfill";

beforeEach(resetDb);

async function person(name: string, status: "ACTIVE" | "OFFBOARDED" = "ACTIVE") {
  return prisma.person.create({ data: { name, status } });
}

async function record(
  personId: string | null,
  term: string,
  score: number | null,
) {
  return prisma.spanishAssessmentRecord.create({
    data: { email: "", personId, term, termRank: termRankOf(term), score },
  });
}

async function esRow(personId: string) {
  return prisma.personLanguage.findUnique({
    where: { personId_language: { personId, language: "es" } },
  });
}

describe("backfillLanguageBadges", () => {
  it("badges a person scored at the top of the scale", async () => {
    const p = await person("Native Speaker");
    await record(p.id, "Fall 2024", 5);

    const report = await backfillLanguageBadges({ dryRun: false });

    expect(report.counts.badged).toBe(1);
    const row = await esRow(p.id);
    expect(row?.verified).toBe(true);
    expect(row?.verifiedAt).not.toBeNull();
    expect(row?.score).toBe(5);
  });

  it("badges a 3, the conversational floor", async () => {
    const p = await person("Conversational");
    await record(p.id, "Fall 2024", 3);

    await backfillLanguageBadges({ dryRun: false });

    const row = await esRow(p.id);
    expect(row?.verified).toBe(true);
    expect(row?.score).toBe(3);
  });

  // A 2 is a real assessment. It must settle the question (verifiedAt stamped,
  // so they leave the queue) without handing out a badge the roster would act on.
  it("settles a 2 as not verified, keeping the score on file", async () => {
    const p = await person("Some Spanish");
    await record(p.id, "Fall 2024", 2);

    const report = await backfillLanguageBadges({ dryRun: false });

    expect(report.counts.settled).toBe(1);
    const row = await esRow(p.id);
    expect(row?.verified).toBe(false);
    expect(row?.verifiedAt).not.toBeNull();
    expect(row?.score).toBe(2);
  });

  it("skips a person whose only record carries no score", async () => {
    const p = await person("Assessed No Number");
    await record(p.id, "Fall 2015", null);

    const report = await backfillLanguageBadges({ dryRun: false });

    expect(report.counts["no-score"]).toBe(1);
    expect(await esRow(p.id)).toBeNull();
  });

  // A later scoreless row records that an assessment happened, not that the
  // earlier score was withdrawn.
  it("uses the most recent SCORED record when a later record has no score", async () => {
    const p = await person("Scored Then Not");
    await record(p.id, "Fall 2018", 4);
    await record(p.id, "Fall 2024", null);

    await backfillLanguageBadges({ dryRun: false });

    const row = await esRow(p.id);
    expect(row?.verified).toBe(true);
    expect(row?.score).toBe(4);
  });

  it("prefers the newest score when several are on file", async () => {
    const p = await person("Improved");
    await record(p.id, "Fall 2018", 3);
    await record(p.id, "Spring 2026", 5);

    await backfillLanguageBadges({ dryRun: false });

    expect((await esRow(p.id))?.score).toBe(5);
  });

  // A reviewer ruled in Hub. A 2014 spreadsheet row must not reverse them.
  it("never reverses a reviewer's verdict, and fills only a missing score", async () => {
    const p = await person("Already Assessed");
    await record(p.id, "Fall 2024", 5);
    await prisma.personLanguage.create({
      data: {
        personId: p.id,
        language: "es",
        verified: false,
        verifiedAt: new Date("2026-08-20"),
        score: null,
      },
    });

    const report = await backfillLanguageBadges({ dryRun: false });

    expect(report.counts["score-filled"]).toBe(1);
    const row = await esRow(p.id);
    expect(row?.verified).toBe(false);
    expect(row?.score).toBe(5);
  });

  it("leaves an assessed row that already has a score completely alone", async () => {
    const p = await person("Fully Assessed");
    await record(p.id, "Fall 2024", 5);
    const assessedAt = new Date("2026-08-20");
    await prisma.personLanguage.create({
      data: { personId: p.id, language: "es", verified: true, verifiedAt: assessedAt, score: 3 },
    });

    const report = await backfillLanguageBadges({ dryRun: false });

    expect(report.counts.unchanged).toBe(1);
    const row = await esRow(p.id);
    expect(row?.score).toBe(3);
    expect(row?.verifiedAt).toEqual(assessedAt);
  });

  it("counts an unlinked record and never guesses at a person for it", async () => {
    await record(null, "Fall 2016", 5);

    const report = await backfillLanguageBadges({ dryRun: false });

    expect(report.unlinkedRecords).toBe(1);
    expect(report.rows).toHaveLength(0);
    expect(await prisma.personLanguage.count()).toBe(0);
  });

  it("ignores people who are no longer active", async () => {
    const p = await person("Alum", "OFFBOARDED");
    await record(p.id, "Fall 2024", 5);

    const report = await backfillLanguageBadges({ dryRun: false });

    expect(report.rows).toHaveLength(0);
    expect(await esRow(p.id)).toBeNull();
  });

  it("writes nothing on a dry run but reports what it would do", async () => {
    const p = await person("Dry Run");
    await record(p.id, "Fall 2024", 5);

    const report = await backfillLanguageBadges({ dryRun: true });

    expect(report.counts.badged).toBe(1);
    expect(await esRow(p.id)).toBeNull();
  });

  // Re-running after reviewers have worked the queue must be a no-op on
  // everything they touched.
  it("is idempotent: a second run changes nothing", async () => {
    const p = await person("Twice");
    await record(p.id, "Fall 2024", 5);

    await backfillLanguageBadges({ dryRun: false });
    const first = await esRow(p.id);
    const second = await backfillLanguageBadges({ dryRun: false });

    expect(second.counts.badged).toBe(0);
    expect(second.counts.unchanged).toBe(1);
    expect((await esRow(p.id))?.verifiedAt).toEqual(first?.verifiedAt);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/platform/languages/badge-backfill.test.ts`
Expected: FAIL, cannot resolve `./badge-backfill`.

- [ ] **Step 4: Write the implementation**

Create `src/platform/languages/badge-backfill.ts`:

```ts
/**
 * One-time backfill of Spanish badges from the imported INTP assessment list.
 *
 * scripts/import-spanish-assessments.ts deliberately writes nothing to
 * PersonLanguage ("verified is decided in Hub by a reviewer, never by the
 * import"), which was right for an import and left every historical decision
 * stranded: 1567 assessment records exist and exactly one person carries a
 * verified Spanish badge. This carries them across.
 *
 * Lives here rather than in the script because nothing under scripts/ is
 * testable, which is the same reason spanish-assessments.ts was lifted out of
 * the review page's server actions.
 */

import { prisma } from "@/platform/db";
import { SPANISH, SPANISH_SPEAKER_MIN_SCORE } from "./catalog";

export type BadgeBackfillOutcome =
  /** Scored at or above the badge floor with no prior assessment. Now verified. */
  | "badged"
  /** Scored below the floor with no prior assessment. Assessed, not verified. */
  | "settled"
  /** A reviewer had already ruled but recorded no number. Score filled in. */
  | "score-filled"
  /** Already assessed and already scored. Untouched. */
  | "unchanged"
  /** Has assessment records, none of which carries a score. Untouched. */
  | "no-score";

export type BadgeBackfillRow = {
  personId: string;
  name: string;
  outcome: BadgeBackfillOutcome;
  score: number | null;
  term: string | null;
};

export type BadgeBackfillReport = {
  rows: BadgeBackfillRow[];
  counts: Record<BadgeBackfillOutcome, number>;
  /**
   * Records with no personId. Informational only: not one of them matches a
   * Person by email, name, or NetID, so there is nothing to link automatically
   * and this module never guesses.
   */
  unlinkedRecords: number;
};

export async function backfillLanguageBadges(
  opts: { dryRun: boolean },
): Promise<BadgeBackfillReport> {
  const unlinkedRecords = await prisma.spanishAssessmentRecord.count({
    where: { personId: null },
  });

  // Every record belonging to an ACTIVE person, newest first. Ordered exactly
  // as latestSpanishAssessment orders, so the backfill and the profile badge
  // can never disagree about which assessment is the current one.
  const records = await prisma.spanishAssessmentRecord.findMany({
    where: { person: { status: "ACTIVE" } },
    orderBy: [{ termRank: "desc" }, { createdAt: "desc" }],
    select: {
      personId: true,
      score: true,
      term: true,
      person: { select: { name: true } },
    },
  });

  // Two facts from one pass: who has any record at all, and each person's most
  // recent record that actually carries a number.
  const seen = new Map<string, string>();
  const latest = new Map<string, { score: number; term: string }>();
  for (const r of records) {
    if (!r.personId || !r.person) continue;
    if (!seen.has(r.personId)) seen.set(r.personId, r.person.name);
    if (r.score === null || latest.has(r.personId)) continue;
    latest.set(r.personId, { score: r.score, term: r.term });
  }

  const existing = await prisma.personLanguage.findMany({
    where: { personId: { in: [...seen.keys()] }, language: SPANISH },
    select: { personId: true, verifiedAt: true, score: true },
  });
  const byPerson = new Map(existing.map((r) => [r.personId, r]));

  const rows: BadgeBackfillRow[] = [];
  const counts: Record<BadgeBackfillOutcome, number> = {
    badged: 0,
    settled: 0,
    "score-filled": 0,
    unchanged: 0,
    "no-score": 0,
  };

  for (const [personId, name] of seen) {
    const record = latest.get(personId);
    if (!record) {
      rows.push({ personId, name, outcome: "no-score", score: null, term: null });
      counts["no-score"] += 1;
      continue;
    }

    const current = byPerson.get(personId);
    const base = { personId, name, score: record.score, term: record.term };

    if (current?.verifiedAt) {
      // A human has ruled. Their verdict stands; only a missing number is
      // additive enough to write.
      if (current.score !== null) {
        rows.push({ ...base, outcome: "unchanged" });
        counts.unchanged += 1;
        continue;
      }
      rows.push({ ...base, outcome: "score-filled" });
      counts["score-filled"] += 1;
      if (!opts.dryRun) {
        await prisma.personLanguage.update({
          where: { personId_language: { personId, language: SPANISH } },
          data: { score: record.score },
        });
      }
      continue;
    }

    const verified = record.score >= SPANISH_SPEAKER_MIN_SCORE;
    rows.push({ ...base, outcome: verified ? "badged" : "settled" });
    counts[verified ? "badged" : "settled"] += 1;
    if (!opts.dryRun) {
      const note = `Backfilled from the ${record.term} assessment list.`;
      await prisma.personLanguage.upsert({
        where: { personId_language: { personId, language: SPANISH } },
        create: {
          personId,
          language: SPANISH,
          verified,
          verifiedAt: new Date(),
          score: record.score,
          note,
        },
        // verifiedById stays null: no person made this call, and inventing an
        // actor would misattribute it to whoever ran the script.
        update: { verified, verifiedAt: new Date(), score: record.score, note },
      });
    }
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { rows, counts, unlinkedRecords };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/platform/languages/badge-backfill.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Write the script wrapper**

Create `scripts/backfill-language-badges.ts`:

```ts
/**
 * Turn the imported INTP Spanish assessment history into badges.
 *
 * Dry-run by default; pass --apply to write changes.
 *
 *   npm run backfill:langbadges:dry
 *   npm run backfill:langbadges:apply
 *
 * ACTIVE people only, and only from a record that carries a 1-5 score. Never
 * reverses an assessment a reviewer already recorded in Hub. Safe to re-run.
 */
import { backfillLanguageBadges } from "@/platform/languages/badge-backfill";

async function main() {
  const dryRun = !process.argv.includes("--apply");

  console.log(
    dryRun ? "DRY RUN -- no changes will be written." : "APPLY MODE -- writing to database.",
  );
  console.log();

  const { rows, counts, unlinkedRecords } = await backfillLanguageBadges({ dryRun });

  console.log("=== RESULTS ===");
  console.log(`  BADGED       (scored 3-5, now verified):        ${counts.badged}`);
  console.log(`  SETTLED      (scored 1-2, assessed not verified): ${counts.settled}`);
  console.log(`  SCORE FILLED (reviewer had ruled, no number):   ${counts["score-filled"]}`);
  console.log(`  UNCHANGED    (already assessed and scored):     ${counts.unchanged}`);
  console.log(`  NO SCORE     (records exist, none scored):      ${counts["no-score"]}`);
  console.log();
  console.log(`  Unlinked assessment records (not actionable):   ${unlinkedRecords}`);
  console.log();

  if (rows.length === 0) {
    console.log("No active person has a linked assessment record. Nothing to do.");
    return;
  }

  console.log("--- per person ---");
  for (const r of rows) {
    const score = r.score === null ? "no score" : `score ${r.score}`;
    const term = r.term ? `, ${r.term}` : "";
    console.log(`  [${r.outcome}] ${r.name}  (${score}${term})`);
  }
  console.log();

  console.log(
    dryRun ? "Dry run complete. Re-run with --apply to write changes." : "Backfill applied successfully.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 7: Wire the npm scripts**

In `package.json`, directly after the `backfill:languages:apply` line, add:

```json
    "backfill:langbadges:dry": "tsx --env-file=.env scripts/backfill-language-badges.ts",
    "backfill:langbadges:apply": "tsx --env-file=.env scripts/backfill-language-badges.ts --apply",
```

- [ ] **Step 8: Verify the whole platform suite and lint**

Run: `npx vitest run src/platform`
Expected: PASS.

Run: `npx eslint src e2e`
Expected: no errors. `src e2e` explicitly, because a bare `npx eslint .` walks the gitignored design-system directory.

- [ ] **Step 9: Commit**

```bash
git add src/platform/languages/catalog.ts src/platform/languages/badge-backfill.ts \
        src/platform/languages/badge-backfill.test.ts scripts/backfill-language-badges.ts package.json
git commit -m "feat(languages): backfill Spanish badges from the assessment history

The assessment importer deliberately never wrote PersonLanguage, which left
1567 imported records stranded behind a single verified badge clinic-wide.
This carries the historical decisions across for active people: a most-recent
scored record of 3-5 badges them, 1-2 settles them as assessed but not
verified, and a record with no number is left alone.

Never reverses a verdict a reviewer already recorded in Hub; where they ruled
without writing a number, only the score is filled in. Unlinked records are
counted and never guessed at. Safe to re-run.

Claude-Session: https://claude.ai/code/session_01N5wMvToB8VoMaqaYGW4tvd"
```

---

### Task 2: Delete the INTP/general queue split

**Files:**
- Modify: `src/platform/languages/index.ts:56-105` (the `LanguageReviewRow` type, `listLanguageReviewQueue`, and the `INTP_DEPARTMENT_CODE` constant that follows it)
- Modify: `src/platform/languages/index.test.ts:125-222` (the "INTP / general queue split" describe block)
- Modify: `src/app/(app)/volunteers/spanish-review/page.tsx:234-235` and the `activeTab === "queue"` block at 259-357

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `LanguageReviewRow` loses its `isIntp: boolean` field. No other signature changes. `recordLanguageAssessment` is untouched, including its tri-state `score` parameter.

- [ ] **Step 1: Update the tests first**

`src/platform/languages/index.test.ts` line 125 opens `describe("the INTP / general queue split", ...)`, which holds, in order: the `activeTerm()` and `intpDept()` helpers, four `isIntp` tests, and one score test.

Delete these four tests outright, since they assert a distinction that stops existing:
- `"marks a current INTP member for the assessment queue"`
- `"does not mark someone INTP on the strength of a past term"`
- `"does not mark someone INTP on a membership that is no longer ACTIVE"`
- `"puts everyone in the general queue when no term is active"`

Delete the `activeTerm()` and `intpDept()` helpers with them. Both are local to this describe block and used only by those four tests, so leaving them behind trips `@typescript-eslint/no-unused-vars`. (`recordLanguageAssessment`'s own tests live in a separate describe block and build their own fixtures.)

**Keep** `"surfaces the current score on the queue row"`, the last test in the block. It exercises `score`, not membership.

Rename the block, which no longer describes a split:

```ts
describe("the language review queue", () => {
```

Add this test alongside the surviving score test:

```ts
  // The queue used to split on active-term INTP membership: interpreting members
  // were scored and everyone else got a bare yes/no. That is exactly why a
  // department willing to staff a conversational speaker had no number to
  // compare against its own bar.
  it("returns one flat queue regardless of interpreting membership", async () => {
    const outsider = await person("Outside Interpreting");
    await claimLanguage(outsider.id, "es");

    const rows = await listLanguageReviewQueue();

    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("isIntp");
    expect(rows[0].score).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify the new one fails**

Run: `npx vitest run src/platform/languages/index.test.ts`
Expected: FAIL on `not.toHaveProperty("isIntp")`, because the field is still returned.

- [ ] **Step 3: Simplify the queue read**

In `src/platform/languages/index.ts`, replace the `LanguageReviewRow` type, `listLanguageReviewQueue`, and the `INTP_DEPARTMENT_CODE` constant with:

```ts
export type LanguageReviewRow = {
  id: string;
  personId: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  language: string;
  languageLabel: string;
  score: number | null;
};

/**
 * One queue for everyone. This used to split on active-term INTP membership
 * into a scored assessment queue and an unscored "general verification" one,
 * which meant a Spanish speaker outside interpreting never got a number at all.
 * Departments differ on what they will staff (Department.minInterpreterScore),
 * and that call needs a score for every speaker, not only for interpreters.
 */
export async function listLanguageReviewQueue(): Promise<LanguageReviewRow[]> {
  const rows = await prisma.personLanguage.findMany({
    where: languageReviewWhere(),
    orderBy: [{ person: { name: "asc" } }, { language: "asc" }],
    select: {
      id: true,
      personId: true,
      language: true,
      score: true,
      person: { select: { name: true, netId: true, contactEmail: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    personId: r.personId,
    name: r.person.name,
    netId: r.person.netId,
    contactEmail: r.person.contactEmail,
    language: r.language,
    languageLabel: languageLabel(r.language),
    score: r.score,
  }));
}
```

Leave the `getActiveTerm` import in place: `recordLanguageAssessment` still uses it to mirror the decision into the assessment history.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/platform/languages/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Collapse the two queue sections into one**

In `src/app/(app)/volunteers/spanish-review/page.tsx`, delete the two lines at 234-235:

```ts
  const intpRows = queueRows.filter((r) => r.isIntp);
  const generalRows = queueRows.filter((r) => !r.isIntp);
```

Then replace the entire `{activeTab === "queue" && (...)}` block with:

```tsx
      {activeTab === "queue" && (
        <section>
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-foreground">Language review queue</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Everyone who reported speaking a language and is awaiting assessment. Record a 1-5
              proficiency score for Spanish speakers before verifying: departments differ on the
              score they will staff, so a conversational speaker is useful to someone even when
              they are below the clinic-wide interpreting bar. The score is internal and is never
              shown to the volunteer.
            </p>
          </div>
          {queueRows.length === 0 ? (
            <EmptyCard>No one is awaiting language review.</EmptyCard>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Language</TH>
                  <TH>NetID</TH>
                  <TH>Current score</TH>
                  <TH>Assessment</TH>
                </TR>
              </THead>
              <tbody>
                {queueRows.map((r) => (
                  <TR key={r.id}>
                    <TD className="font-medium">{r.name}</TD>
                    <TD>
                      <Badge>{r.languageLabel}</Badge>
                    </TD>
                    <TD className="text-muted-foreground">
                      {r.netId ?? <span className="text-subtle-foreground">-</span>}
                    </TD>
                    <TD>
                      {r.language !== SPANISH ? (
                        <span className="text-xs text-subtle-foreground">-</span>
                      ) : r.score === null ? (
                        <span className="text-xs text-subtle-foreground">Not yet scored</span>
                      ) : (
                        <Badge tone={spanishScoreTone(r.score)}>
                          {formatSpanishScore(r.score, null)}
                        </Badge>
                      )}
                    </TD>
                    <TD>
                      <AssessForm row={r} action={assessAction} withScore={r.language === SPANISH} />
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      )}
```

The `Email` column that the old general queue carried is dropped: commit `1d9843aa` already removed it once as noise, and NetID identifies a volunteer here.

- [ ] **Step 6: Verify the build, the suite, and lint**

Run: `npx tsc --noEmit`
Expected: no errors. This is what catches any remaining `isIntp` reference.

Run: `npx vitest run src/platform`
Expected: PASS.

Run: `npx eslint src e2e`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/platform/languages/index.ts src/platform/languages/index.test.ts \
        "src/app/(app)/volunteers/spanish-review/page.tsx"
git commit -m "feat(languages): score every language claim, not only interpreters

The review queue split on active-term INTP membership into a scored assessment
queue and a general one whose own help text read \"No score is recorded here.\"
So a Spanish speaker outside interpreting never got a number, and the
per-department bar built to place them (Department.minInterpreterScore,
interpreterBarFor, meetsInterpreterBar) had nothing to compare against.

One queue now, with the score field on every Spanish row. This reaches 36 of
the 51 claims currently waiting.

Claude-Session: https://claude.ai/code/session_01N5wMvToB8VoMaqaYGW4tvd"
```

---

### Task 3: The ES+ tier on the roster badge

**Files:**
- Modify: `src/platform/languages/catalog.ts` (add one constant)
- Modify: `src/modules/schedule/components/capability-badges.tsx:64-84`
- Modify: `src/modules/schedule/components/capability-badges.test.tsx`

**Interfaces:**
- Consumes: `SPANISH`, `interpreterBarFor`, `meetsInterpreterBar`, `languageLabel`, and `spanishProficiencyLabel` from `@/platform/languages/catalog` (the first four are already imported by the component).
- Produces: `SPANISH_TOP_SCORE = 5` exported from `./catalog`. No component signature change: `CapabilityBadges` keeps the same props.

- [ ] **Step 1: Add the constant**

In `src/platform/languages/catalog.ts`, directly below `SPANISH_SPEAKER_MIN_SCORE` (added in Task 1), add:

```ts
/**
 * The top of the scale, rendered as a "+" on the roster badge so a director
 * scanning a shift can pick out a native speaker without reading numbers.
 */
export const SPANISH_TOP_SCORE = 5;
```

- [ ] **Step 2: Write the failing tests**

Append to `src/modules/schedule/components/capability-badges.test.tsx`, inside the existing describe block that covers the score cases:

```ts
  it("marks the top of the scale with a plus", () => {
    const host = render({ verifiedLanguages: ["es"], licensedRN: false, spanishScore: 5 });
    expect(host.textContent).toContain("ES+");
  });

  it("names the level in the accessible text for a top scorer", () => {
    const host = render({ verifiedLanguages: ["es"], licensedRN: false, spanishScore: 5 });
    expect(accessibleText(host)).toContain("Verified: Spanish, assessed 5 (Native)");
  });

  it("shows a plain code for a 4, which is fluent but not native", () => {
    const host = render({ verifiedLanguages: ["es"], licensedRN: false, spanishScore: 4 });
    expect(host.textContent).toContain("ES");
    expect(host.textContent).not.toContain("ES+");
  });

  it("shows a plain code for a 3 where the department accepts it", () => {
    const host = render(
      { verifiedLanguages: ["es"], licensedRN: false, spanishScore: 3 },
      { minInterpreterScore: 3 },
    );
    expect(host.textContent).toContain("ES");
    expect(host.textContent).not.toContain("ES+");
  });

  // The below-bar mark already shows the exact number, so a "+" on top of it
  // would be noise. It also cannot co-occur in practice unless a department
  // sets its bar to 5.
  it("prefers the below-bar shortfall over the plus tier", () => {
    const host = render(
      { verifiedLanguages: ["es"], licensedRN: false, spanishScore: 5 },
      { minInterpreterScore: 5 },
    );
    expect(host.textContent).not.toContain("ES+");
  });

  it("leaves a non-Spanish language unmarked at any score", () => {
    const host = render({ verifiedLanguages: ["ht"], licensedRN: false, spanishScore: 5 });
    expect(host.textContent).toContain("HT");
    expect(host.textContent).not.toContain("HT+");
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/modules/schedule/components/capability-badges.test.tsx`
Expected: FAIL on the `ES+` assertions; the component renders a bare `ES`.

- [ ] **Step 4: Add the tier to the component**

In `src/modules/schedule/components/capability-badges.tsx`, add `SPANISH_TOP_SCORE` and `spanishProficiencyLabel` to the existing import from `@/platform/languages/catalog`, then replace the body of the `person.verifiedLanguages.map` callback with:

```tsx
      {person.verifiedLanguages.map((code) => {
        // Spanish carries an INTP proficiency score, and departments differ on
        // what they will staff: 4 clinic-wide, 3 where conversational is enough.
        // A director looking at this row is deciding who interprets for a
        // patient right now, so a speaker below THIS department's bar says so
        // rather than looking identical to one who clears it.
        const flagged = code === SPANISH && spanishBelowBar;
        // The shortfall wins over the tier: it already shows the exact number,
        // so a "+" on top of it would be noise.
        const top = !flagged && code === SPANISH && score === SPANISH_TOP_SCORE;
        const label = flagged
          ? `Verified: ${languageLabel(code)}, assessed ${score} (below this department's bar of ${bar})`
          : top
            ? `Verified: ${languageLabel(code)}, assessed ${score} (${spanishProficiencyLabel(score)})`
            : `Verified: ${languageLabel(code)}`;
        return (
          <Badge key={code} tone={flagged ? "warning" : "brand"} title={label}>
            <span aria-hidden>
              {code.toUpperCase()}
              {flagged ? ` ${score}` : ""}
              {top ? "+" : ""}
            </span>
            <span className="sr-only">{label}</span>
          </Badge>
        );
      })}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/modules/schedule/components/capability-badges.test.tsx`
Expected: PASS, including the pre-existing tests. In particular `"keeps the tooltip for the sighted mouse user it does serve"` must still see exactly `"Verified: Spanish"`, because it renders an unscored person.

- [ ] **Step 6: Verify the suite and lint**

Run: `npx vitest run src/platform src/modules/schedule`
Expected: PASS.

Run: `npx eslint src e2e`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/platform/languages/catalog.ts \
        src/modules/schedule/components/capability-badges.tsx \
        src/modules/schedule/components/capability-badges.test.tsx
git commit -m "feat(schedule): mark a native Spanish speaker as ES+ on the roster

A director scanning a shift for someone to interpret reads codes, not numbers.
The top of the INTP scale now renders as ES+ so it stands out from the fluent
and conversational speakers sharing the row.

The existing below-bar mark wins over the tier, since it already shows the
exact score and a plus on top of it would be noise.

Claude-Session: https://claude.ai/code/session_01N5wMvToB8VoMaqaYGW4tvd"
```

---

## Self-Review

**Spec coverage.** Every section maps to a task:

| Spec section | Task |
| --- | --- |
| Backfill: decision table (3-5 badge, 1-2 settle, score written) | 1, Steps 2 and 4 |
| Backfill: most recent *scored* record | 1, Step 2 test "uses the most recent SCORED record" |
| Backfill: people with no scored record skipped | 1, Step 2 test "skips a person whose only record" |
| Backfill: never reverse, fill missing score only | 1, Step 2 tests "never reverses" and "leaves an assessed row" |
| Backfill: unlinked records skipped and counted | 1, Step 2 test "counts an unlinked record" |
| Backfill: re-runnable | 1, Step 2 test "is idempotent" |
| Backfill: logic testable outside `scripts/` | 1, module split across Steps 4 and 6 |
| Backfill: dry run reports the counts | 1, Steps 4 and 6 |
| Delete `isIntp` and the membership sub-select | 2, Step 3 |
| One queue table with the score control | 2, Step 5 |
| `recordLanguageAssessment` unchanged | 2, Interfaces block |
| Four `isIntp` tests removed | 2, Step 1 |
| `ES` / `ES+` tier, below-bar wins | 3, Steps 2 and 4 |
| Accessible name follows the text | 3, Step 2 test "names the level" |
| Rollout | Not a task. Operator steps live in the spec. |

**Placeholder scan.** No TBD, no "add error handling", no "similar to Task N". Every code step carries the actual code.

**Type consistency.** `BadgeBackfillOutcome` members are used identically in the module, the tests, and the script's output block. `SPANISH_SPEAKER_MIN_SCORE` is added and consumed in Task 1 only; `SPANISH_TOP_SCORE` is added and consumed in Task 3 only, so neither task depends on the other's constant. `LanguageReviewRow` loses `isIntp` in Task 2 and the page stops reading it in the same task.

**One ordering note for the executor:** Task 1 and Task 3 both edit `catalog.ts`, adding adjacent constants. Run them in order, or expect a trivial conflict in that one file if they are parallelised.
