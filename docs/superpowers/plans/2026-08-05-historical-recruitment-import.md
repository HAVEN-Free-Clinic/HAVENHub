# Historical Recruitment Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import ten completed Airtable recruitment cycles into HAVEN Hub as an outcome trail, and surface each applicant's prior contact with HAVEN on the reviewer page, the person profile, and a searchable browser.

**Architecture:** Five pure adapters normalize five different Airtable shapes into one `RawHistoryRow` type. A pure union-find pass resolves identities across all rows before any write. Rows land in three new tables that live recruitment queries never touch. A single read service unions those archive rows with live `Application` rows through one shared stage mapper, so future Hub cycles join the same timeline for free.

**Tech Stack:** TypeScript, Next.js App Router (RSC), Prisma + Postgres, Vitest, Playwright.

## Global Constraints

- **No em-dashes anywhere**, in code, comments, docs, or UI copy. CI enforces this via the `local/no-em-dash` eslint rule and a violation fails lint.
- **Never use `tailwind-merge`.** It is deliberately absent from this project.
- Import scripts are read-only against Airtable. Never write to an Airtable base.
- Every Airtable read goes through `AirtableClient` (`src/platform/airtable/client.ts`) with `returnFieldsByFieldId=true`. Field IDs, never field names.
- NetID extraction always goes through `isNetIdShaped` from `src/platform/auth/match-person.ts`. Never write a non-NetID-shaped value into a NetID column.
- Test fixtures are hand-written and synthetic. Never copy real applicant records from Airtable into the repo.
- Tests need a per-worktree database: `export TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_rechistory"`. The `haven` role on :5434 is a superuser and can create databases.
- Run `npx eslint src e2e` (not `npm run lint`, which walks an untracked gitignored design-system directory).
- Timestamps display in the configurable app timezone via `src/platform/dates`. Use the `DateTime` display component, never raw `toLocaleString`.

---

## File Structure

**New, import side** (`src/platform/airtable/import/history/`):

| File | Responsibility |
|---|---|
| `types.ts` | `RawHistoryRow`, `RawInterestRow`, the shared adapter contract |
| `sources.ts` | Registry of the 11 sources. Data only, no logic |
| `stages.ts` | The stage/outcome ladder and its label helpers. Shared with the live-era mapper |
| `departments.ts` | Airtable department name to Hub department code |
| `identity.ts` | Union-find over netId and email edges |
| `adapters/volunteer-modern.ts` | SP25, SU25, FA25, SP26 |
| `adapters/volunteer-fa24.ts` | The round-split shape |
| `adapters/volunteer-su26.ts` | Applicants / Acceptances / Contracts |
| `adapters/director.ts` | FA24, SU25, FA25, SU26 |
| `adapters/interest-form.ts` | Interest form responses |
| `load.ts` | Idempotent upsert |
| `report.ts` | Dry-run report shape and formatter |

**New, read side:**

| File | Responsibility |
|---|---|
| `src/modules/recruitment/services/history.ts` | `getApplicantHistory`, unions archive and live eras |
| `src/modules/recruitment/components/applicant-history.tsx` | The one component, mounted three times |
| `src/app/(app)/recruitment/history/page.tsx` | Searchable browser |
| `src/app/(app)/recruitment/history/[applicantId]/page.tsx` | Identity detail |
| `scripts/import-history.ts` | CLI entry, `--dry` default |

**Modified:**

| File | Change |
|---|---|
| `prisma/schema.prisma` | Three models, two enums, one `Person` back-relation |
| `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` | Mount the card |
| `src/app/(app)/admin/people/[id]/page.tsx` | Mount the section |
| `src/platform/modules/registry.ts` | Add the History nav item |
| `package.json` | `import:history:dry`, `import:history:apply` |

---

## Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_historical_recruitment/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `HistoricalApplicant`, `HistoricalApplicantEmail`, `HistoricalApplication`, `HistoricalInterest`; enums `HistoricalStage` (`APPLIED ADVANCED FINAL_ROUND ACCEPTED ONBOARDED`) and `HistoricalOutcome` (`ACCEPTED REJECTED WAITLISTED WITHDRAWN INELIGIBLE NO_DECISION UNKNOWN`).

- [ ] **Step 1: Add the enums and models to `prisma/schema.prisma`**

Append the full block from the spec's section 2. Also add the back-relation to `Person`, next to the other named relations:

```prisma
historicalApplicantLinks HistoricalApplicant[] @relation("historicalApplicantPerson")
```

- [ ] **Step 2: Generate the migration**

```bash
export TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_rechistory"
DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL_UNPOOLED="$TEST_DATABASE_URL" \
  npx prisma migrate dev --name historical_recruitment --create-only
```

- [ ] **Step 3: Trim the migration and fix the array default**

`migrate dev` folds any pre-existing drift into the new migration. Open the generated `migration.sql` and delete every statement that does not concern the four new tables or two new enums.

Then check the `departmentChoices` column. Prisma sometimes emits `DEFAULT '{}'` for `String[]`; it must read:

```sql
"departmentChoices" TEXT[] DEFAULT ARRAY[]::TEXT[],
```

- [ ] **Step 4: Apply and verify**

```bash
export TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_rechistory"
DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL_UNPOOLED="$TEST_DATABASE_URL" npx prisma migrate deploy
psql "$TEST_DATABASE_URL" -c '\d "HistoricalApplication"'
```

Expected: the table exists with the `@@unique` on the three source columns.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(recruitment): add historical application models"
```

---

## Task 2: The stage ladder

**Files:**
- Create: `src/platform/airtable/import/history/stages.ts`
- Test: `src/platform/airtable/import/history/stages.test.ts`

**Interfaces:**
- Consumes: the Prisma enums from Task 1.
- Produces:
  - `type StageSignals = { advanced: boolean; finalRound: boolean; accepted: boolean; onboarded: boolean }`
  - `deriveStage(signals: StageSignals): HistoricalStage`
  - `parseOutcome(raw: string | null | undefined): HistoricalOutcome`
  - `stageLabel(stage: HistoricalStage, track: Track): string`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { deriveStage, parseOutcome, stageLabel } from "./stages";

const none = { advanced: false, finalRound: false, accepted: false, onboarded: false };

describe("deriveStage", () => {
  it("returns APPLIED when nothing else is signalled", () => {
    expect(deriveStage(none)).toBe("APPLIED");
  });

  it("returns the FURTHEST stage, not the first true one", () => {
    expect(deriveStage({ ...none, advanced: true, finalRound: true })).toBe("FINAL_ROUND");
    expect(deriveStage({ ...none, advanced: true, accepted: true })).toBe("ACCEPTED");
    expect(deriveStage({ ...none, accepted: true, onboarded: true })).toBe("ONBOARDED");
  });

  it("does not require lower stages to be set, since old cycles skipped them", () => {
    // V-SP26 records acceptance with no round-1 selection row at all.
    expect(deriveStage({ ...none, accepted: true })).toBe("ACCEPTED");
  });
});

describe("parseOutcome", () => {
  // Every string in this block is a REAL value tallied from the ten source
  // bases on 2026-08-05, with its row count. Do not replace them with
  // invented vocabulary: an earlier draft of this table matched /^accept/i
  // and would have imported all 2097 "Approved" and "Confirmed" rows as
  // UNKNOWN while rejections mapped fine, producing a history in which
  // almost nobody was ever accepted.
  it("maps the acceptance words these bases actually use", () => {
    expect(parseOutcome("Approved")).toBe("ACCEPTED");   // 1270 rows
    expect(parseOutcome("Confirmed")).toBe("ACCEPTED");  // 827 rows
    expect(parseOutcome("Accepted")).toBe("ACCEPTED");
  });

  it("maps every rejection spelling, including the FA24 reason suffixes", () => {
    expect(parseOutcome("Rejected")).toBe("REJECTED");                          // 618
    expect(parseOutcome("Rejection - Department Capacity")).toBe("REJECTED");    // 163
    expect(parseOutcome("Rejection - Other")).toBe("REJECTED");                  // 19
    expect(parseOutcome("Denied")).toBe("REJECTED");
  });

  it("prefers INELIGIBLE over REJECTED when a rejection names ineligibility", () => {
    // Ops ruling: these applicants were not turned down on merit, so a later
    // reapplication must not read as a prior rejection. Order-dependent.
    expect(parseOutcome("Rejection - Ineligible Applicant")).toBe("INELIGIBLE"); // 19
    expect(parseOutcome("Ineligible")).toBe("INELIGIBLE");                       // 5
  });

  it("treats in-flight states from closed cycles as no decision", () => {
    expect(parseOutcome("Pending")).toBe("NO_DECISION");               // 2
    expect(parseOutcome("Awaiting Confirmation")).toBe("NO_DECISION"); // 1
    expect(parseOutcome("R2 Deferral")).toBe("NO_DECISION");           // 10
  });

  it("does not let 'Awaiting Confirmation' be captured by the Confirmed rule", () => {
    // Regression guard for the anchoring on the ACCEPTED pattern.
    expect(parseOutcome("Awaiting Confirmation")).not.toBe("ACCEPTED");
  });

  it("maps the remaining tail values", () => {
    expect(parseOutcome("Withdrawn")).toBe("WITHDRAWN"); // 1
    expect(parseOutcome("Waitlist")).toBe("WAITLISTED");
  });

  it("distinguishes absent from unrecognized", () => {
    expect(parseOutcome(null)).toBe("NO_DECISION");
    expect(parseOutcome("")).toBe("NO_DECISION");
    expect(parseOutcome("Purple")).toBe("UNKNOWN");
  });
});

describe("stageLabel", () => {
  it("names FINAL_ROUND per track", () => {
    expect(stageLabel("FINAL_ROUND", "DIRECTOR")).toBe("Interviewed");
    expect(stageLabel("FINAL_ROUND", "VOLUNTEER")).toBe("Round 2");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
export TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_rechistory"
npx vitest run src/platform/airtable/import/history/stages.test.ts
```

Expected: FAIL, cannot resolve `./stages`.

- [ ] **Step 3: Implement**

```ts
import type { HistoricalOutcome, HistoricalStage, Track } from "@prisma/client";

export type StageSignals = {
  advanced: boolean;
  finalRound: boolean;
  accepted: boolean;
  onboarded: boolean;
};

/**
 * The furthest stage reached, checked highest-first. Deliberately does NOT
 * require the lower rungs to be set: several old cycles recorded an acceptance
 * without ever populating a selection row (V-SP26 records nothing but an
 * ACCEPTED? checkbox), and demanding a contiguous ladder would silently
 * downgrade those to APPLIED.
 */
export function deriveStage(s: StageSignals): HistoricalStage {
  if (s.onboarded) return "ONBOARDED";
  if (s.accepted) return "ACCEPTED";
  if (s.finalRound) return "FINAL_ROUND";
  if (s.advanced) return "ADVANCED";
  return "APPLIED";
}

/**
 * Ordered: the FIRST matching pattern wins, so the order encodes real
 * precedence decisions rather than style.
 *
 * Every pattern is derived from the actual distinct values across all ten
 * source bases, tallied 2026-08-05, not from guesswork:
 *
 *   Approved 1270, Confirmed 827, Rejected 618,
 *   "Rejection - Department Capacity" 163, "Rejection - Ineligible Applicant" 19,
 *   "Rejection - Other" 19, "R2 Deferral" 10, Ineligible 5, Pending 2,
 *   Withdrawn 1, "Awaiting Confirmation" 1
 *
 * Note that "Approved" and "Confirmed", not "Accepted", are how these bases
 * actually spell an acceptance. They are 2097 of the 2131 acceptances.
 *
 * Two orderings are load-bearing:
 *
 *   INELIGIBLE precedes REJECTED so "Rejection - Ineligible Applicant" lands
 *   as INELIGIBLE. Ops ruled those applicants were not turned down on merit,
 *   so a later reapplication must not read as a prior rejection.
 *
 *   The in-flight patterns precede ACCEPTED so "Awaiting Confirmation" is not
 *   swallowed by the "Confirmed" rule. ACCEPTED is anchored with ^ for the
 *   same reason. Do not relax it to a substring match.
 */
const OUTCOMES: Array<[RegExp, HistoricalOutcome]> = [
  [/ineligib/i, "INELIGIBLE"],
  [/^(pending|awaiting)/i, "NO_DECISION"],
  [/defer/i, "NO_DECISION"],
  [/^(approve|confirm|accept)/i, "ACCEPTED"],
  [/^(reject|den(y|ied))/i, "REJECTED"],
  [/^wait ?list/i, "WAITLISTED"],
  [/^withdr/i, "WITHDRAWN"],
];

/**
 * NO_DECISION means the source recorded nothing. UNKNOWN means it recorded
 * something this mapper does not understand: the two must stay distinct so the
 * dry-run report can surface real vocabulary drift instead of burying it in
 * the same bucket as the (very common) blank cell.
 */
export function parseOutcome(raw: string | null | undefined): HistoricalOutcome {
  const value = raw?.trim();
  if (!value) return "NO_DECISION";
  for (const [pattern, outcome] of OUTCOMES) if (pattern.test(value)) return outcome;
  return "UNKNOWN";
}

export function stageLabel(stage: HistoricalStage, track: Track): string {
  switch (stage) {
    case "APPLIED": return "Applied";
    case "ADVANCED": return "Advanced";
    case "FINAL_ROUND": return track === "DIRECTOR" ? "Interviewed" : "Round 2";
    case "ACCEPTED": return "Accepted";
    case "ONBOARDED": return "Onboarded";
  }
}
```

- [ ] **Step 4: Run and confirm it passes**

```bash
npx vitest run src/platform/airtable/import/history/stages.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/platform/airtable/import/history/stages.ts src/platform/airtable/import/history/stages.test.ts
git commit -m "feat(recruitment): add the historical stage and outcome ladder"
```

---

## Task 3: Identity resolution

**Files:**
- Create: `src/platform/airtable/import/history/identity.ts`
- Test: `src/platform/airtable/import/history/identity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type IdentityInput = { key: string; firstName: string; lastName: string; email: string | null; netId: string | null }`
  - `type ResolvedIdentity = { netId: string | null; primaryEmail: string; firstName: string; lastName: string; emails: string[]; memberKeys: string[] }`
  - `resolveIdentities(rows: IdentityInput[]): ResolvedIdentity[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { resolveIdentities } from "./identity";

const row = (key: string, email: string | null, netId: string | null, first = "Ada", last = "Lovelace") =>
  ({ key, firstName: first, lastName: last, email, netId });

describe("resolveIdentities", () => {
  it("merges rows sharing an email", () => {
    const out = resolveIdentities([row("a", "x@yale.edu", null), row("b", "X@Yale.edu", null)]);
    expect(out).toHaveLength(1);
    expect(out[0].memberKeys.sort()).toEqual(["a", "b"]);
  });

  it("merges rows sharing a netId even with different emails", () => {
    const out = resolveIdentities([row("a", "old@yale.edu", "abc12"), row("b", "new@gmail.com", "abc12")]);
    expect(out).toHaveLength(1);
    expect(out[0].emails.sort()).toEqual(["new@gmail.com", "old@yale.edu"]);
  });

  it("transitively merges two clusters joined by a later row", () => {
    // The case that defeats incremental resolution: a and b look unrelated
    // until c arrives carrying both edges.
    const out = resolveIdentities([
      row("a", "x@yale.edu", null),
      row("b", "y@yale.edu", "abc12"),
      row("c", "x@yale.edu", "abc12"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].memberKeys.sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps genuinely distinct people apart", () => {
    const out = resolveIdentities([row("a", "x@yale.edu", "abc12"), row("b", "y@yale.edu", "def34")]);
    expect(out).toHaveLength(2);
  });

  it("never merges on a null netId", () => {
    const out = resolveIdentities([row("a", "x@yale.edu", null), row("b", "y@yale.edu", null)]);
    expect(out).toHaveLength(2);
  });

  it("emits exactly one primaryEmail that is present in emails", () => {
    const out = resolveIdentities([row("a", "x@yale.edu", "abc12"), row("b", "y@yale.edu", "abc12")]);
    expect(out[0].emails).toContain(out[0].primaryEmail);
  });

  it("drops rows with neither an email nor a netId", () => {
    expect(resolveIdentities([row("a", null, null)])).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run src/platform/airtable/import/history/identity.test.ts
```

- [ ] **Step 3: Implement**

```ts
export type IdentityInput = {
  /** Caller-owned handle (the source record id). Returned in memberKeys. */
  key: string;
  firstName: string;
  lastName: string;
  email: string | null;
  netId: string | null;
};

export type ResolvedIdentity = {
  netId: string | null;
  primaryEmail: string;
  firstName: string;
  lastName: string;
  emails: string[];
  memberKeys: string[];
};

/**
 * Union-find over the netId and email edges of every extracted row, run as one
 * batch before any write.
 *
 * Batch rather than incremental because merges are discovered out of order: a
 * row carrying only email A and a row carrying only netId X look unrelated
 * until a third row carrying BOTH arrives, at which point the first two must
 * retroactively become one person. An incremental resolver would already have
 * written them as two.
 */
export function resolveIdentities(rows: IdentityInput[]): ResolvedIdentity[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(x) !== root) {
      const next = parent.get(x)!;
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  const add = (x: string) => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a: string, b: string) => { parent.set(find(a), find(b)); };

  const usable = rows
    .map((r) => ({
      ...r,
      email: r.email?.trim().toLowerCase() || null,
      netId: r.netId?.trim().toLowerCase() || null,
    }))
    .filter((r) => r.email || r.netId);

  // Node namespacing keeps an email that happens to equal a netId from joining
  // two unrelated people.
  for (const r of usable) {
    const self = `row:${r.key}`;
    add(self);
    if (r.email) { add(`email:${r.email}`); union(self, `email:${r.email}`); }
    if (r.netId) { add(`netid:${r.netId}`); union(self, `netid:${r.netId}`); }
  }

  const clusters = new Map<string, typeof usable>();
  for (const r of usable) {
    const root = find(`row:${r.key}`);
    const bucket = clusters.get(root) ?? [];
    bucket.push(r);
    clusters.set(root, bucket);
  }

  return [...clusters.values()].map((members) => {
    const emails = [...new Set(members.map((m) => m.email).filter((e): e is string => Boolean(e)))];
    const netId = members.find((m) => m.netId)?.netId ?? null;
    // Prefer a yale.edu address as the display primary; fall back to the first.
    const primaryEmail = emails.find((e) => e.endsWith("@yale.edu")) ?? emails[0];
    const named = members.find((m) => m.firstName || m.lastName) ?? members[0];
    return {
      netId,
      primaryEmail,
      firstName: named.firstName,
      lastName: named.lastName,
      emails,
      memberKeys: members.map((m) => m.key),
    };
  }).filter((identity) => Boolean(identity.primaryEmail));
}
```

- [ ] **Step 4: Run and confirm it passes**

```bash
npx vitest run src/platform/airtable/import/history/identity.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/platform/airtable/import/history/identity.ts src/platform/airtable/import/history/identity.test.ts
git commit -m "feat(recruitment): resolve historical applicant identities via union-find"
```

---

## Task 4: Department resolution

**Files:**
- Create: `src/platform/airtable/import/history/departments.ts`
- Test: `src/platform/airtable/import/history/departments.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `resolveDepartmentCode(raw: string | null | undefined, knownCodes: Set<string>): string | null`
  - `resolveDepartmentCodes(raw: Array<string | null | undefined>, knownCodes: Set<string>): { codes: string[]; unmapped: string[] }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { resolveDepartmentCode, resolveDepartmentCodes } from "./departments";

const known = new Set(["BVHD", "SCTP", "SCTS", "INTP", "ITCM"]);

describe("resolveDepartmentCode", () => {
  it("passes a known code straight through, case-insensitively", () => {
    expect(resolveDepartmentCode("BVHD", known)).toBe("BVHD");
    expect(resolveDepartmentCode("bvhd", known)).toBe("BVHD");
  });

  it("extracts the bracketed code from a friendly label", () => {
    expect(resolveDepartmentCode("Blood Pressure & Vascular Health (BVHD)", known)).toBe("BVHD");
  });

  it("trims surrounding whitespace", () => {
    expect(resolveDepartmentCode("  SCTP  ", known)).toBe("SCTP");
  });

  it("returns null for blank input", () => {
    expect(resolveDepartmentCode(null, known)).toBeNull();
    expect(resolveDepartmentCode("   ", known)).toBeNull();
  });

  it("returns null for a code that is not known, rather than inventing one", () => {
    expect(resolveDepartmentCode("XXXX", known)).toBeNull();
  });

  it("resolves every ops-confirmed alias to its live code", () => {
    // Confirmed by ops on 2026-08-05 against the real unresolved list, never
    // guessed. TBAD and LCCN in particular are ones no fuzzy matcher would
    // ever have reached, and ICCD/FCLR are ones a fuzzy matcher would have
    // "corrected" without authority.
    const live = new Set(["ICDD", "PNLC", "SCTP", "SRR", "ITCM", "FCRL"]);
    expect(resolveDepartmentCode("TBAD", live)).toBe("ICDD");   // 49 rows
    expect(resolveDepartmentCode("PNTC", live)).toBe("PNLC");   // 37 rows
    expect(resolveDepartmentCode("SCTL", live)).toBe("SCTP");   // 26 rows
    expect(resolveDepartmentCode("ICCD", live)).toBe("ICDD");   // 19 rows
    expect(resolveDepartmentCode("LCCN", live)).toBe("PNLC");   // 14 rows
    expect(resolveDepartmentCode("SR&R", live)).toBe("SRR");    //  8 rows
    expect(resolveDepartmentCode("ITCC", live)).toBe("ITCM");   //  7 rows
    expect(resolveDepartmentCode("FCLR", live)).toBe("FCRL");   //  3 rows
  });

  it("matches an alias case-insensitively", () => {
    expect(resolveDepartmentCode("tbad", new Set(["ICDD"]))).toBe("ICDD");
  });

  it("returns null when an alias points at a department that does not exist", () => {
    // The alias is applied before the known-codes check but its TARGET is
    // still validated, so a retired target can never write a dangling code.
    expect(resolveDepartmentCode("TBAD", new Set(["BVHD"]))).toBeNull();
  });
});

describe("resolveDepartmentCodes", () => {
  it("dedupes, preserves order, and reports the unmapped separately", () => {
    const out = resolveDepartmentCodes(["BVHD", "bvhd", "XXXX", null, "SCTP"], known);
    expect(out.codes).toEqual(["BVHD", "SCTP"]);
    expect(out.unmapped).toEqual(["XXXX"]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run src/platform/airtable/import/history/departments.test.ts
```

- [ ] **Step 3: Implement**

```ts
/**
 * Retired or mistyped codes, mapped to their live equivalents. Every entry
 * here was confirmed by ops on 2026-08-05 against the real unresolved list;
 * NONE were guessed. That distinction is the whole point: several of these
 * look like transpositions a fuzzy matcher would "helpfully" correct
 * (ICCD/ICDD, FCLR/FCRL), and two of them (TBAD, LCCN) resolve to departments
 * a fuzzy matcher would never have reached. Guessing would have been wrong
 * both ways.
 *
 * Row counts at the time of confirmation, 163 rows total:
 *   TBAD 49, PNTC 37, SCTL 26, ICCD 19, LCCN 14, SR&R 8, ITCC 7, FCLR 3
 *
 * All eight targets were verified present in the live department set (the 32
 * codes on the SU26 and SP26 rosters).
 */
export const DEPARTMENT_ALIASES: Record<string, string> = {
  TBAD: "ICDD",
  PNTC: "PNLC",
  SCTL: "SCTP",
  ICCD: "ICDD",
  LCCN: "PNLC",
  "SR&R": "SRR",
  ITCC: "ITCM",
  FCLR: "FCRL",
};

/**
 * Old bases spell a department four ways: the bare code ("BVHD"), a friendly
 * label with the code in parentheses, a retired or mistyped code covered by
 * DEPARTMENT_ALIASES, and occasionally something nobody recognizes. The
 * resolver never invents a code: an unrecognized value returns null and is
 * surfaced in the dry-run report, because silently coercing it would attribute
 * an application to the wrong department forever.
 *
 * An alias is applied BEFORE the known-codes check, and its target is still
 * validated against the live codes, so an alias pointing at a department that
 * does not exist resolves to null rather than writing a dangling code.
 */
export function resolveDepartmentCode(
  raw: string | null | undefined,
  knownCodes: Set<string>,
): string | null {
  const value = raw?.trim();
  if (!value) return null;

  const upper = value.toUpperCase();
  // Alias first, but its target is still validated below, so an alias
  // pointing at a department that no longer exists returns null rather than
  // writing a dangling code.
  const aliased = DEPARTMENT_ALIASES[upper] ?? upper;
  if (knownCodes.has(aliased)) return aliased;

  const bracketed = value.match(/\(([^)]+)\)\s*$/);
  if (bracketed) {
    const code = bracketed[1].trim().toUpperCase();
    if (knownCodes.has(code)) return code;
  }
  return null;
}

export function resolveDepartmentCodes(
  raw: Array<string | null | undefined>,
  knownCodes: Set<string>,
): { codes: string[]; unmapped: string[] } {
  const codes: string[] = [];
  const unmapped: string[] = [];
  for (const value of raw) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const code = resolveDepartmentCode(trimmed, knownCodes);
    if (!code) {
      if (!unmapped.includes(trimmed)) unmapped.push(trimmed);
      continue;
    }
    if (!codes.includes(code)) codes.push(code);
  }
  return { codes, unmapped };
}
```

- [ ] **Step 4: Run and confirm it passes**

```bash
npx vitest run src/platform/airtable/import/history/departments.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/platform/airtable/import/history/departments.ts src/platform/airtable/import/history/departments.test.ts
git commit -m "feat(recruitment): map Airtable department labels to Hub codes"
```

---

## Task 5: The adapter contract and source registry

**Files:**
- Create: `src/platform/airtable/import/history/types.ts`
- Create: `src/platform/airtable/import/history/sources.ts`
- Test: `src/platform/airtable/import/history/sources.test.ts`

**Interfaces:**
- Consumes: `HistoricalStage`, `HistoricalOutcome`, `Track`, `ApplicantType` from Prisma.
- Produces: `RawHistoryRow`, `RawInterestRow`, `HistorySource`, `HISTORY_SOURCES`.

- [ ] **Step 1: Write `types.ts`**

```ts
import type { ApplicantType, HistoricalOutcome, HistoricalStage, Track } from "@prisma/client";

/**
 * The single shape every adapter emits. Five very different Airtable layouts
 * collapse to this type at the boundary so identity resolution, department
 * mapping, loading and reporting are each written once.
 */
export type RawHistoryRow = {
  source: { baseId: string; tableId: string; recordId: string };
  cycle: { code: string; label: string; track: Track; termCode: string | null };
  identity: { firstName: string; lastName: string; email: string | null; netId: string | null };
  applicantType: ApplicantType | null;
  /** Raw Airtable labels. Mapped to Hub codes later, by departments.ts. */
  departmentChoicesRaw: Array<string | null>;
  resultDepartmentRaw: string | null;
  furthestStage: HistoricalStage;
  outcome: HistoricalOutcome;
  submittedAt: Date | null;
  decidedAt: Date | null;
  /** Anything the adapter could not map. Surfaced by the report, never rendered. */
  unmapped: Record<string, unknown> | null;
};

export type RawInterestRow = {
  source: { baseId: string; tableId: string; recordId: string };
  identity: { firstName: string; lastName: string; email: string | null; netId: string | null };
  submittedAt: Date | null;
};
```

- [ ] **Step 2: Write `sources.ts`**

Every ID below is verified live against the Airtable API on 2026-08-05.

```ts
import type { Track } from "@prisma/client";

export type HistorySource = {
  code: string;
  label: string;
  track: Track;
  termCode: string | null;
  baseId: string;
  adapter: "volunteer-modern" | "volunteer-fa24" | "volunteer-su26" | "director" | "interest-form";
  /** Adapter-specific table ids. Keys are documented per adapter. */
  tables: Record<string, string>;
};

/**
 * Excluded on purpose, do not re-add without re-checking:
 *   appX9dVg2g9FDJlMl  D-WN26, a clone of D-FA25 carrying the same 89 record ids
 *   appJRUKtCBmg7w3Cp  D-SP25, zero records
 *   app7f51P5guqc8jou  D-SP26, zero records
 *   appIgxGgVKVeSNF72  V-FA25 duplicate, zero records
 *   appXFdgWx7syySXZ1  V-May26, a snapshot copy of the V-SU26 base
 */
export const HISTORY_SOURCES: HistorySource[] = [
  {
    code: "V-FA24", label: "Fall 2024 Volunteer Recruitment", track: "VOLUNTEER", termCode: "FA24",
    baseId: "appSzCKAaB1c1v1f4", adapter: "volunteer-fa24",
    tables: {
      r1New: "tblE35VBMvgvXCepT",
      r1Returning: "tbljJ1ofRVfS9FRy9",
      r1Switch: "tblYgUZqNomvZsIbM",
      r1Ineligible: "tbloxUbXIlwn7RKq1",
      r2All: "tbluCYYTPdZeTt5hU",
      finalDecisions: "tblxJQfR65pPfL4tI",
      nonYale: "tblJ4b5xaCf3ImqEg",
    },
  },
  ...(["SP25", "SU25", "FA25", "SP26"] as const).map((term, i) => ({
    code: `V-${term}`,
    label: { SP25: "Spring 2025", SU25: "Summer 2025", FA25: "Fall 2025", SP26: "Spring 2026" }[term] + " Volunteer Recruitment",
    track: "VOLUNTEER" as Track,
    termCode: term,
    baseId: ["appWSVTqKqiwVyVio", "appBTfqxZSHyf1LBl", "app0DXgMSFvsWW4t8", "appsXFzmnfi5vWzrJ"][i],
    adapter: "volunteer-modern" as const,
    // Table ids are identical across this lineage because each base was
    // duplicated from its predecessor.
    tables: { applications: "tblJPuEMyBq5c2x0W" },
  })),
  {
    // Only the Applicants table is fetched: it carries link fields to
    // Acceptances (tblc15YeGhahLxeA9) and Contracts (tblW5qmRckmvz1QGX), so
    // membership in those is readable without reading them.
    code: "V-SU26", label: "Summer 2026 Volunteer Recruitment", track: "VOLUNTEER", termCode: "SU26",
    baseId: "appOq1yOiA1Lfzq8L", adapter: "volunteer-su26",
    tables: { applicants: "tblV3UrQQvIIZzFTU" },
  },
  ...([
    ["D-FA24", "Fall 2024", "FA24", "appwhZqNU4zCkQ9U2"],
    ["D-SU25", "Summer 2025", "SU25", "app5ma8K8a1qansUu"],
    ["D-FA25", "Fall 2025", "FA25", "appvvlDJLmGfN0340"],
  ] as const).map(([code, name, termCode, baseId]) => ({
    code, label: `${name} Director Recruitment`, track: "DIRECTOR" as Track, termCode,
    baseId, adapter: "director" as const,
    // Applications carries the STAGE (its Interview Details, Decisions and
    // Director Contracts links), but the decision VALUE lives only on Final
    // Decisions: Applications has no decision lookup, verified 2026-08-05.
    // Without this second table every rejection imports as NO_DECISION.
    tables: { applications: "tbluFoybFPBjBAXyk", finalDecisions: "tblfw1kjlBc5fULrY" },
  })),
  {
    // This base has neither a Final Decisions nor a Candidate Evaluations
    // table. The director adapter reads only Applications regardless, deriving
    // everything from its link fields, so no deviation is needed here.
    code: "D-SU26", label: "Summer 2026 Director Recruitment", track: "DIRECTOR", termCode: "SU26",
    baseId: "app6MHzSA1yPej2zX", adapter: "director",
    // No Final Decisions table here; this cycle recorded its 36 outcomes in an
    // Acceptances table instead. Omitting it imports every SU26 director as
    // undecided.
    tables: { applications: "tbluFoybFPBjBAXyk", acceptances: "tblqM7b0f5srEmbBw" },
  },
  {
    code: "INTEREST", label: "Interest form", track: "VOLUNTEER", termCode: null,
    baseId: "appyZMpXNJ0rVzOT8", adapter: "interest-form",
    tables: { responses: "tblEacqiHtqKMJphX", responsesOld: "tbl55zvZUFQgcnp04" },
  },
];
```

- [ ] **Step 3: Write the registry guard test**

```ts
import { describe, it, expect } from "vitest";
import { HISTORY_SOURCES } from "./sources";

describe("HISTORY_SOURCES", () => {
  it("has a unique code per source", () => {
    const codes = HISTORY_SOURCES.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("never includes an excluded base", () => {
    // D-WN26 is a clone of D-FA25 and would duplicate all 89 of its applicants.
    const banned = ["appX9dVg2g9FDJlMl", "appJRUKtCBmg7w3Cp", "app7f51P5guqc8jou", "appIgxGgVKVeSNF72", "appXFdgWx7syySXZ1"];
    for (const source of HISTORY_SOURCES) expect(banned).not.toContain(source.baseId);
  });

  it("covers ten cycles plus the interest form", () => {
    expect(HISTORY_SOURCES).toHaveLength(11);
    expect(HISTORY_SOURCES.filter((s) => s.track === "VOLUNTEER" && s.code !== "INTEREST")).toHaveLength(6);
    expect(HISTORY_SOURCES.filter((s) => s.track === "DIRECTOR")).toHaveLength(4);
  });

  it("gives every non-interest source a term code", () => {
    for (const s of HISTORY_SOURCES) {
      if (s.code !== "INTEREST") expect(s.termCode).toBeTruthy();
    }
  });
});
```

- [ ] **Step 4: Run and confirm it passes**

```bash
npx vitest run src/platform/airtable/import/history/sources.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/platform/airtable/import/history/types.ts src/platform/airtable/import/history/sources.ts src/platform/airtable/import/history/sources.test.ts
git commit -m "feat(recruitment): add the history source registry and adapter contract"
```

---

## Task 6: The modern volunteer adapter

**Files:**
- Create: `src/platform/airtable/import/history/adapters/volunteer-modern.ts`
- Test: `src/platform/airtable/import/history/adapters/volunteer-modern.test.ts`

**Interfaces:**
- Consumes: `RawHistoryRow` (Task 5), `deriveStage` / `parseOutcome` (Task 2), `AirtableRecord` from `src/platform/airtable/client.ts`.
- Produces: `MODERN_VOLUNTEER_FIELDS` and `transformModernVolunteer(records: AirtableRecord[], source: HistorySource): RawHistoryRow[]`.

**Background the implementer needs:** this lineage's Round 1 Applications table carries link fields to every downstream table, so the whole ladder derives from one table read. A non-empty link array is the stage signal. Field IDs are identical across SP25, SU25, FA25 and SP26 (verified).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { transformModernVolunteer, MODERN_VOLUNTEER_FIELDS as F } from "./volunteer-modern";

const SOURCE = {
  code: "V-FA25", label: "Fall 2025 Volunteer Recruitment", track: "VOLUNTEER" as const,
  termCode: "FA25", baseId: "app0DXgMSFvsWW4t8", adapter: "volunteer-modern" as const,
  tables: { applications: "tblJPuEMyBq5c2x0W" },
};

const record = (id: string, fields: Record<string, unknown>) => ({ id, fields });

describe("transformModernVolunteer", () => {
  it("reads identity from the field ids, not names", () => {
    const [row] = transformModernVolunteer([record("rec1", {
      [F.firstName]: "Ada", [F.lastName]: "Lovelace",
      [F.email]: "Ada@Yale.edu", [F.netId]: "AL123",
    })], SOURCE);
    expect(row.identity).toEqual({ firstName: "Ada", lastName: "Lovelace", email: "Ada@Yale.edu", netId: "al123" });
    expect(row.source).toEqual({ baseId: SOURCE.baseId, tableId: "tblJPuEMyBq5c2x0W", recordId: "rec1" });
  });

  it("rejects a NetID-shaped check failure rather than writing it", () => {
    const [row] = transformModernVolunteer([record("rec1", {
      [F.email]: "a@yale.edu", [F.netId]: "not a netid!",
    })], SOURCE);
    expect(row.identity.netId).toBeNull();
    expect(row.unmapped).toMatchObject({ rejectedNetId: "not a netid!" });
  });

  it("derives ADVANCED from a non-empty Round 1 Selections link", () => {
    const [row] = transformModernVolunteer([record("rec1", {
      [F.email]: "a@yale.edu", [F.r1Selections]: ["recSel1"],
    })], SOURCE);
    expect(row.furthestStage).toBe("ADVANCED");
  });

  it("derives FINAL_ROUND from a Round 2 link", () => {
    const [row] = transformModernVolunteer([record("rec1", {
      [F.email]: "a@yale.edu", [F.r1Selections]: ["recSel1"], [F.r2Applications]: ["recR2"],
    })], SOURCE);
    expect(row.furthestStage).toBe("FINAL_ROUND");
  });

  it("reads the outcome from the FD Decision lookup and marks ACCEPTED", () => {
    const [row] = transformModernVolunteer([record("rec1", {
      [F.email]: "a@yale.edu", [F.finalDecisions]: ["recFD"], [F.fdDecision]: ["Accepted"],
    })], SOURCE);
    expect(row.outcome).toBe("ACCEPTED");
    expect(row.furthestStage).toBe("ACCEPTED");
  });

  it("treats an empty link array as absent", () => {
    const [row] = transformModernVolunteer([record("rec1", {
      [F.email]: "a@yale.edu", [F.r1Selections]: [],
    })], SOURCE);
    expect(row.furthestStage).toBe("APPLIED");
    expect(row.outcome).toBe("NO_DECISION");
  });

  it("falls back to the ACCEPTED? checkbox for SP26, which has nothing else", () => {
    const sp26 = { ...SOURCE, code: "V-SP26", baseId: "appsXFzmnfi5vWzrJ" };
    const [row] = transformModernVolunteer([record("rec1", {
      [F.email]: "a@yale.edu", [F.acceptedCheckbox]: true,
    })], sp26);
    expect(row.furthestStage).toBe("ACCEPTED");
    expect(row.outcome).toBe("ACCEPTED");
  });

  it("collects both department choices in rank order", () => {
    const [row] = transformModernVolunteer([record("rec1", {
      [F.email]: "a@yale.edu", [F.dept1]: "BVHD", [F.dept2]: "SCTP",
    })], SOURCE);
    expect(row.departmentChoicesRaw).toEqual(["BVHD", "SCTP"]);
  });

  it("skips rows with no email and no netId, which are Airtable cruft", () => {
    expect(transformModernVolunteer([record("rec1", {})], SOURCE)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run src/platform/airtable/import/history/adapters/volunteer-modern.test.ts
```

- [ ] **Step 3: Implement**

```ts
import type { AirtableRecord } from "../../../client";
import { isNetIdShaped } from "@/platform/auth/match-person";
import { deriveStage, parseOutcome } from "../stages";
import type { HistorySource } from "../sources";
import type { RawHistoryRow } from "../types";

/**
 * Field ids on Round 1 Applications (tblJPuEMyBq5c2x0W). Verified identical
 * across V-SP25, V-SU25, V-FA25 and V-SP26 on 2026-08-05: each base was
 * duplicated from its predecessor, so Airtable preserved the ids of every
 * field that already existed. Later cycles only ADD fields.
 */
export const MODERN_VOLUNTEER_FIELDS = {
  firstName: "fldQA7KFcUNM5cUqn",
  lastName: "fldX0RAj3S0psMSSp",
  email: "fldkynQt6MUSpmkhv",
  netId: "fldtAreIGp2junzjR",
  dept1: "fldivjUqzeXPczHyH",
  dept2: "fldQfIQswsmCSyoNV",
  r1Selections: "fldjynzhT3vXhfvTi",
  r2Applications: "fldt1KIkLCdkOpBwu",
  r2Selections: "fldAOwxW8t639e5uk",
  finalDecisions: "fldrwLEgdh6Acf3Tl",
  fdDecision: "fld3PcyqYyRONmiEi",
  /** SP26 only. That cycle recorded nothing else. */
  acceptedCheckbox: "fldzBRNBv4AjmsIb0",
} as const;

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
};
const linked = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
const lookupFirst = (v: unknown): string | null =>
  Array.isArray(v) ? str(v[0]) : str(v);

export function transformModernVolunteer(
  records: AirtableRecord[],
  source: HistorySource,
): RawHistoryRow[] {
  const F = MODERN_VOLUNTEER_FIELDS;
  const rows: RawHistoryRow[] = [];

  for (const record of records) {
    const f = record.fields;
    const email = str(f[F.email]);
    const rawNetId = str(f[F.netId]);
    // A nameless, contactless row is Airtable cruft, not an application.
    if (!email && !rawNetId) continue;

    const unmapped: Record<string, unknown> = {};
    let netId: string | null = null;
    if (rawNetId && isNetIdShaped(rawNetId)) netId = rawNetId.toLowerCase();
    else if (rawNetId) unmapped.rejectedNetId = rawNetId;

    const decisionRaw = lookupFirst(f[F.fdDecision]);
    const outcome = parseOutcome(decisionRaw);
    if (outcome === "UNKNOWN") unmapped.decision = decisionRaw;

    const acceptedByCheckbox = f[F.acceptedCheckbox] === true;
    const furthestStage = deriveStage({
      advanced: linked(f[F.r1Selections]),
      finalRound: linked(f[F.r2Applications]) || linked(f[F.r2Selections]),
      accepted: outcome === "ACCEPTED" || acceptedByCheckbox,
      // This lineage records onboarding elsewhere; never inferred here.
      onboarded: false,
    });

    rows.push({
      source: { baseId: source.baseId, tableId: source.tables.applications, recordId: record.id },
      cycle: { code: source.code, label: source.label, track: source.track, termCode: source.termCode },
      identity: { firstName: str(f[F.firstName]) ?? "", lastName: str(f[F.lastName]) ?? "", email, netId },
      applicantType: null,
      departmentChoicesRaw: [str(f[F.dept1]), str(f[F.dept2])],
      resultDepartmentRaw: null,
      furthestStage,
      // The checkbox is an acceptance with no recorded decision string.
      outcome: outcome === "NO_DECISION" && acceptedByCheckbox ? "ACCEPTED" : outcome,
      submittedAt: null,
      decidedAt: null,
      unmapped: Object.keys(unmapped).length ? unmapped : null,
    });
  }
  return rows;
}
```

- [ ] **Step 4: Run and confirm it passes**

```bash
npx vitest run src/platform/airtable/import/history/adapters/volunteer-modern.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/platform/airtable/import/history/adapters/volunteer-modern.ts src/platform/airtable/import/history/adapters/volunteer-modern.test.ts
git commit -m "feat(recruitment): add the modern volunteer history adapter"
```

---

## Task 7: The director adapter

**Files:**
- Create: `src/platform/airtable/import/history/adapters/director.ts`
- Test: `src/platform/airtable/import/history/adapters/director.test.ts`

**Interfaces:**
- Consumes: as Task 6.
- Produces: `DIRECTOR_FIELDS`, `DIRECTOR_DECISION_FIELDS`, and `transformDirector(tables: Record<string, AirtableRecord[]>, source: HistorySource): RawHistoryRow[]`.

Note the signature: like the FA24 adapter, this takes a map of already-fetched tables keyed by the `tables` key from the source registry, because it reads two tables.

**Background, and the split that matters:** the Applications table (`tbluFoybFPBjBAXyk`) carries link fields for interviews, decisions and contracts, so it alone determines the **stage**. It does NOT carry the decision **value**: verified on 2026-08-05, its only lookup/formula fields are three name formulas. The value lives on Final Decisions (`tblfw1kjlBc5fULrY`), which has no link back, so the two are joined by lowercased email exactly as the FA24 adapter joins its tables.

Skipping that join would import every non-onboarded director applicant as `NO_DECISION`, erasing the distinction between "interviewed then rejected" and "no decision recorded" across all 260 director applications.

D-SU26 is the exception: it has no Final Decisions table at all, so `tables.finalDecisions` is absent and its acceptance signal stays the Director Contracts link. The adapter must handle an absent table, not assume it.

Verified Final Decisions field ids (`tblfw1kjlBc5fULrY`):

```ts
export const DIRECTOR_DECISION_FIELDS = {
  email: "fld5VMpMm0E4Y0r2D",       // Candidate Email (lookup)
  netId: "fldpZnT1Y7b27OzEv",       // Candidate Yale NetID (lookup)
  status: "fldH8btzgKjLu3b6j",      // Status (singleLineText)
  departmentHire: "fldfUyRMWRw3d6IWs", // Department HIRE (singleSelect)
} as const;
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import {
  transformDirector,
  DIRECTOR_FIELDS as F,
  DIRECTOR_DECISION_FIELDS as D,
  DIRECTOR_ACCEPTANCE_FIELDS as A,
} from "./director";

const SOURCE = {
  code: "D-FA25", label: "Fall 2025 Director Recruitment", track: "DIRECTOR" as const,
  termCode: "FA25", baseId: "appvvlDJLmGfN0340", adapter: "director" as const,
  tables: { applications: "tbluFoybFPBjBAXyk", finalDecisions: "tblfw1kjlBc5fULrY" },
};
// D-SU26 genuinely has no Final Decisions table.
const SOURCE_SU26 = {
  ...SOURCE, code: "D-SU26", termCode: "SU26", baseId: "app6MHzSA1yPej2zX",
  tables: { applications: "tbluFoybFPBjBAXyk" },
};
const record = (id: string, fields: Record<string, unknown>) => ({ id, fields });
const only = (applications: ReturnType<typeof record>[]) => ({ applications, finalDecisions: [] });

describe("transformDirector", () => {
  it("reads identity from the director field ids", () => {
    const [row] = transformDirector(only([record("rec1", {
      [F.firstName]: "Ada", [F.lastName]: "Lovelace",
      [F.email]: "ada@yale.edu", [F.netId]: "al123",
    })]), SOURCE);
    expect(row.identity.email).toBe("ada@yale.edu");
    expect(row.identity.netId).toBe("al123");
    expect(row.cycle.track).toBe("DIRECTOR");
  });

  it("derives FINAL_ROUND from an interview link", () => {
    const [row] = transformDirector(only([record("rec1", {
      [F.email]: "a@yale.edu", [F.interviews]: ["recIntv"],
    })]), SOURCE);
    expect(row.furthestStage).toBe("FINAL_ROUND");
  });

  it("derives ONBOARDED from a contract link", () => {
    const [row] = transformDirector(only([record("rec1", {
      [F.email]: "a@yale.edu", [F.interviews]: ["recIntv"], [F.contracts]: ["recCon"],
    })]), SOURCE);
    expect(row.furthestStage).toBe("ONBOARDED");
  });

  it("collects all three department choices in rank order", () => {
    const [row] = transformDirector(only([record("rec1", {
      [F.email]: "a@yale.edu", [F.dept1]: "ITCM", [F.dept2]: "BVHD", [F.dept3]: "SCTP",
    })]), SOURCE);
    expect(row.departmentChoicesRaw).toEqual(["ITCM", "BVHD", "SCTP"]);
  });

  it("reads REJECTED from Final Decisions, joined by email", () => {
    // The whole point of the second table: without it this row would be
    // NO_DECISION and indistinguishable from an undecided applicant.
    const [row] = transformDirector({
      applications: [record("rec1", { [F.email]: "Ada@Yale.edu", [F.interviews]: ["recIntv"] })],
      finalDecisions: [record("recFD", { [D.email]: ["ada@yale.edu"], [D.status]: "Rejected" })],
    }, SOURCE);
    expect(row.furthestStage).toBe("FINAL_ROUND");
    expect(row.outcome).toBe("REJECTED");
  });

  it("reads ACCEPTED and the hired department from Final Decisions", () => {
    const [row] = transformDirector({
      applications: [record("rec1", { [F.email]: "a@yale.edu" })],
      finalDecisions: [record("recFD", {
        [D.email]: ["a@yale.edu"], [D.status]: "Accepted", [D.departmentHire]: "ITCM",
      })],
    }, SOURCE);
    expect(row.outcome).toBe("ACCEPTED");
    expect(row.resultDepartmentRaw).toBe("ITCM");
    expect(row.furthestStage).toBe("ACCEPTED");
  });

  it("reports NO_DECISION when no Final Decisions row matches", () => {
    const [row] = transformDirector({
      applications: [record("rec1", { [F.email]: "a@yale.edu" })],
      finalDecisions: [record("recFD", { [D.email]: ["someone-else@yale.edu"], [D.status]: "Rejected" })],
    }, SOURCE);
    expect(row.outcome).toBe("NO_DECISION");
  });

  it("works when the source has no Final Decisions table at all (D-SU26)", () => {
    const [row] = transformDirector({
      applications: [record("rec1", { [F.email]: "a@yale.edu", [F.contracts]: ["recCon"] })],
    }, SOURCE_SU26);
    expect(row.furthestStage).toBe("ONBOARDED");
    expect(row.outcome).toBe("ACCEPTED");
  });

  it("falls back to the linked-record email when the direct field is empty", () => {
    // Not a hypothetical: 57 of D-SU26's 76 rows look like this, because
    // returning applicants link an existing record instead of retyping.
    // Reading only F.email drops three quarters of that cycle.
    const [row] = transformDirector({
      applications: [record("rec1", { [F.emailFromRecord]: ["linked@yale.edu"] })],
      finalDecisions: [],
    }, SOURCE_SU26);
    expect(row).toBeDefined();
    expect(row.identity.email).toBe("linked@yale.edu");
  });

  it("counts the ALTERNATE contract link, which is the only one D-SU26 uses", () => {
    // Verified: on D-SU26 the primary contracts field is populated on 0 of 76
    // rows and this one on 36. Reading only the primary loses every SU26
    // onboarding.
    const [row] = transformDirector({
      applications: [record("rec1", { [F.email]: "a@yale.edu", [F.contractsAlt]: ["recCon"] })],
    }, SOURCE_SU26);
    expect(row.furthestStage).toBe("ONBOARDED");
    expect(row.outcome).toBe("ACCEPTED");
  });

  it("reads an Acceptances row as an acceptance, joined by email", () => {
    // D-SU26 has no Final Decisions table; its 36 outcomes live here.
    const [row] = transformDirector({
      applications: [record("rec1", { [F.email]: "Ada@Yale.edu" })],
      acceptances: [record("recA", {
        [A.email]: ["ada@yale.edu"], [A.department]: ["ITCM"],
      })],
    }, SOURCE_SU26);
    expect(row.outcome).toBe("ACCEPTED");
    expect(row.resultDepartmentRaw).toBe("ITCM");
    expect(row.furthestStage).toBe("ACCEPTED");
  });

  it("leaves an applicant with no acceptance row undecided", () => {
    const [row] = transformDirector({
      applications: [record("rec1", { [F.email]: "a@yale.edu" })],
      acceptances: [record("recA", { [A.email]: ["other@yale.edu"] })],
    }, SOURCE_SU26);
    expect(row.outcome).toBe("NO_DECISION");
  });

  it("prefers the direct email when both are present", () => {
    const [row] = transformDirector({
      applications: [record("rec1", {
        [F.email]: "direct@yale.edu", [F.emailFromRecord]: ["linked@yale.edu"],
      })],
      finalDecisions: [],
    }, SOURCE_SU26);
    expect(row.identity.email).toBe("direct@yale.edu");
  });

  it("skips contactless rows", () => {
    expect(transformDirector(only([record("rec1", {})]), SOURCE)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run src/platform/airtable/import/history/adapters/director.test.ts
```

- [ ] **Step 3: Implement**

```ts
import type { AirtableRecord } from "../../../client";
import { isNetIdShaped } from "@/platform/auth/match-person";
import { deriveStage, parseOutcome } from "../stages";
import type { HistorySource } from "../sources";
import type { RawHistoryRow } from "../types";

/**
 * Field ids on the director Applications table (tbluFoybFPBjBAXyk). Stable
 * across D-FA24, D-SU25, D-FA25 and D-SU26 for the same duplication reason as
 * the volunteer lineage.
 */
export const DIRECTOR_FIELDS = {
  firstName: "fldmyKP0uuIvMWo2F",
  lastName: "fldr0cJ1wWVMB9HjJ",
  email: "flddxvLy47P1dotdt",
  /**
   * SECOND email source, and it is not optional. D-SU26 routes most applicants
   * through a linked record, so the direct Yale Email field is EMPTY on 57 of
   * its 76 rows while this lookup carries 58. Reading only `email` would drop
   * three quarters of that cycle as contactless cruft. Verified 2026-08-05:
   *   D-SU26: Yale Email 19/76, email from record 58/76, union 75/76.
   * Absent on the older director bases, where `fields[...]` is simply
   * undefined and the fallback is a no-op.
   */
  emailFromRecord: "fldERuDIrmqOiLrzC",
  netId: "fldDT16TCdgMZmB9S",
  dept1: "fldQJbP4sHT2w2Vit",
  dept2: "fldGotOFXGfqJr17b",
  dept3: "fldFZROZWVmc9aX7Z",
  interviews: "fldYYMi71F7i2nYPM",
  decisions: "fldTlrJkHmNXvQZAS",
  contracts: "fldcFW0hsfHRsQhsk",
  /**
   * SECOND contract link, and it is the ONLY one D-SU26 uses. Verified
   * 2026-08-05 on that base: `contracts` is populated on 0 of 76 rows while
   * this field carries 36. Reading only `contracts` loses every D-SU26
   * onboarding. Absent on the older bases, where it reads as undefined.
   */
  contractsAlt: "fldG74yBW1LjC6gib",
  returningDepartment: "fldcdPQc9rX8UgYj0",
} as const;

/**
 * D-SU26 alone records outcomes in an Acceptances table (tblqM7b0f5srEmbBw,
 * 36 rows) instead of Final Decisions, which that base does not have. Like
 * Final Decisions it carries no link back to Applications, so the join is
 * again by lowercased email. Verified 2026-08-05: all 36 acceptance emails
 * resolve, matching 37 of the 76 applications, and all 36 carry a department.
 */
export const DIRECTOR_ACCEPTANCE_FIELDS = {
  email: "fldveBn6WeR9iDQBd",       // Email (lookup)
  department: "fldApydh1v6TazK3T",  // Department (lookup)
} as const;

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
};
const linked = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

/** Lookup cells arrive as single-element arrays. */
const lookupFirst = (v: unknown): string | null => (Array.isArray(v) ? str(v[0]) : str(v));

export function transformDirector(
  tables: Record<string, AirtableRecord[]>,
  source: HistorySource,
): RawHistoryRow[] {
  const F = DIRECTOR_FIELDS;
  const D = DIRECTOR_DECISION_FIELDS;
  const rows: RawHistoryRow[] = [];

  // Final Decisions has no link back to Applications, so the join is by
  // lowercased email. D-SU26 has no such table; an absent table is normal,
  // not an error, and simply leaves every decision unresolved.
  const decisions = new Map<string, AirtableRecord>();
  for (const record of tables.finalDecisions ?? []) {
    const email = lookupFirst(record.fields[D.email])?.toLowerCase();
    if (email) decisions.set(email, record);
  }

  // D-SU26 only. Same story as Final Decisions: no link back, so join by
  // lowercased email. Absent on every other director base.
  const acceptances = new Map<string, AirtableRecord>();
  for (const record of tables.acceptances ?? []) {
    const email = lookupFirst(record.fields[A.email])?.toLowerCase();
    if (email) acceptances.set(email, record);
  }

  for (const record of tables.applications ?? []) {
    const f = record.fields;
    // Two sources, in order. See the comment on DIRECTOR_FIELDS.emailFromRecord:
    // reading only the direct field drops 57 of D-SU26's 76 applicants.
    const email = str(f[F.email]) ?? lookupFirst(f[F.emailFromRecord]);
    const rawNetId = str(f[F.netId]);
    if (!email && !rawNetId) continue;

    const unmapped: Record<string, unknown> = {};
    let netId: string | null = null;
    if (rawNetId && isNetIdShaped(rawNetId)) netId = rawNetId.toLowerCase();
    else if (rawNetId) unmapped.rejectedNetId = rawNetId;

    const key = email?.toLowerCase();
    const decision = key ? decisions.get(key) : undefined;
    const acceptance = key ? acceptances.get(key) : undefined;
    const decisionRaw = decision ? str(decision.fields[D.status]) : null;
    const outcome = parseOutcome(decisionRaw);
    if (outcome === "UNKNOWN") unmapped.decision = decisionRaw;

    // Either contract field counts. D-SU26 populates only the second.
    const onboarded = linked(f[F.contracts]) || linked(f[F.contractsAlt]);
    const furthestStage = deriveStage({
      advanced: linked(f[F.interviews]) || linked(f[F.decisions]),
      finalRound: linked(f[F.interviews]),
      accepted: onboarded || outcome === "ACCEPTED" || acceptance !== undefined,
      onboarded,
    });

    rows.push({
      source: { baseId: source.baseId, tableId: source.tables.applications, recordId: record.id },
      cycle: { code: source.code, label: source.label, track: source.track, termCode: source.termCode },
      identity: { firstName: str(f[F.firstName]) ?? "", lastName: str(f[F.lastName]) ?? "", email, netId },
      applicantType: linked(f[F.returningDepartment]) ? "RENEWAL" : null,
      departmentChoicesRaw: [str(f[F.dept1]), str(f[F.dept2]), str(f[F.dept3])],
      resultDepartmentRaw:
        (decision ? str(decision.fields[D.departmentHire]) : null) ??
        (acceptance ? lookupFirst(acceptance.fields[A.department]) : null),
      furthestStage,
      // A contract or an acceptance row is proof of acceptance even when no
      // decision row survives. D-SU26 has no Final Decisions table at all.
      outcome:
        outcome === "NO_DECISION" && (onboarded || acceptance !== undefined)
          ? "ACCEPTED"
          : outcome,
      submittedAt: null,
      decidedAt: null,
      unmapped: Object.keys(unmapped).length ? unmapped : null,
    });
  }
  return rows;
}
```

- [ ] **Step 4: Run and confirm it passes**

```bash
npx vitest run src/platform/airtable/import/history/adapters/director.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/platform/airtable/import/history/adapters/director.ts src/platform/airtable/import/history/adapters/director.test.ts
git commit -m "feat(recruitment): add the director history adapter"
```

---

## Task 8: The FA24, SU26 and interest-form adapters

**Files:**
- Create: `src/platform/airtable/import/history/adapters/volunteer-fa24.ts`
- Create: `src/platform/airtable/import/history/adapters/volunteer-su26.ts`
- Create: `src/platform/airtable/import/history/adapters/interest-form.ts`
- Test: one `.test.ts` beside each

**Interfaces:**
- Produces: `transformVolunteerFa24(tables: Record<string, AirtableRecord[]>, source): RawHistoryRow[]`, `transformVolunteerSu26(tables, source): RawHistoryRow[]`, `transformInterestForm(records, source): RawInterestRow[]`.

Note the signature difference: these three read *multiple* tables, so they take a map of already-fetched records keyed by the `tables` key from the source registry, rather than a flat array.

**Background for FA24, and the two things that make it different:**

1. Applicants are split across `[R1] New`, `[R1] Returning`, `[R1] Returning - Switch`, `[R1] Ineligible` and `Non-Yale`, with `[R2] All` and `Final Decisions` downstream. **There are no link fields anywhere in this base**, so membership is matched by lowercased email.
2. **FA24 has no NetID field on any table.** Identity for this whole cycle is email-only, which means a FA24 applicant merges with later cycles only through a shared address. That is expected, not a bug, and the adapter must not fabricate a NetID.

Every field id below is verified live on 2026-08-05.

- [ ] **Step 1: Write the field constants**

```ts
/**
 * V-FA24 field ids. Unlike every later cycle, each table here has its OWN ids
 * for the same logical field, because these tables were authored separately
 * rather than duplicated. Verified 2026-08-05.
 */
export const FA24_FIELDS = {
  r1New:        { email: "fldfMY7ikGKiaW1Gs", status: "fldYSRiPtJhGg6DcY", first: "fldLOI1uqODcQMBPk", last: "fldSesR8hMQPdmzhm", dept1: "fldWucalULrJOkcKX", dept2: "fldpm5xjFOurMiXmo" },
  r1Returning:  { email: "fldUsUAWp6JFmZEPI", status: "fldO0xoS3TKMpyYbp", first: "fldquEu8veCz2PeYA", last: "fldxUokMmcPcppcqC", dept1: "fldSpQETSyMC9c16U", dept2: "fld5CYLXmvrtPcflN" },
  r1Switch:     { email: "fldoJBVKtrpBP2jKZ", status: "fld7NNixC6dIgb7SC", first: "fldXauc7NmUzfetqc", last: "fldS3KuO99RmGQcDp", dept1: "fldLD1gsVmMrG3OF1", dept2: "fld4Tet6p7roNbVOU" },
  r1Ineligible: { email: "fldmBjFoq1c1GUfDo", status: "fldk1CVnUTuM1n2ep", first: "fldFJYIJt6e699mQw", last: "fldeTSd2Y2atgz68r", dept1: "fldwFejmQjzDCkcsY", dept2: "fldlFY4THisLuaeGp" },
  // The Non-Yale primary field is named "Name" but is typed as an email.
  nonYale:      { email: "fld6aTmcfxG7UeTsL", status: "flddl3VrcXCKl17hg", first: null,                last: "fldPs3AVBccn6yIfX", dept1: "fldWwgNiMR1JJzNpE", dept2: "fldIq1mUOJdqtvuMS" },
  r2All:        { email: "fldU5FUdvg2kJ3GQ7" },
  finalDecisions: { email: "fld4mv32zkY4NXtIW", status: "fldBhoj8Sx3XtksrO", onboarded: "fldxPiBKiukkN0l4b", department: "fldPlk8i79eAZAF50" },
} as const;

/** Which R1 table a row came from decides its applicant type and floor outcome. */
export const FA24_R1_TABLES = [
  { key: "r1New",        applicantType: "NEW" as const,     forcedOutcome: null },
  { key: "r1Returning",  applicantType: "RENEWAL" as const, forcedOutcome: null },
  { key: "r1Switch",     applicantType: "TRANSFER" as const, forcedOutcome: null },
  { key: "r1Ineligible", applicantType: null,                forcedOutcome: "INELIGIBLE" as const },
  { key: "nonYale",      applicantType: "NEW" as const,      forcedOutcome: null },
];
```

- [ ] **Step 2: Write the failing FA24 test**

```ts
import { describe, it, expect } from "vitest";
import { transformVolunteerFa24, FA24_FIELDS as F } from "./volunteer-fa24";
import { HISTORY_SOURCES } from "../sources";

const SOURCE = HISTORY_SOURCES.find((s) => s.code === "V-FA24")!;
const rec = (id: string, fields: Record<string, unknown>) => ({ id, fields });
const empty = { r1New: [], r1Returning: [], r1Switch: [], r1Ineligible: [], nonYale: [], r2All: [], finalDecisions: [] };

describe("transformVolunteerFa24", () => {
  it("emits one row per applicant across every R1 table", () => {
    const rows = transformVolunteerFa24({
      ...empty,
      r1New: [rec("recN", { [F.r1New.email]: "new@yale.edu" })],
      r1Returning: [rec("recR", { [F.r1Returning.email]: "ret@yale.edu" })],
      r1Switch: [rec("recS", { [F.r1Switch.email]: "sw@yale.edu" })],
    }, SOURCE);
    expect(rows).toHaveLength(3);
  });

  it("derives applicantType from which table the row came from", () => {
    const rows = transformVolunteerFa24({
      ...empty,
      r1New: [rec("recN", { [F.r1New.email]: "new@yale.edu" })],
      r1Returning: [rec("recR", { [F.r1Returning.email]: "ret@yale.edu" })],
      r1Switch: [rec("recS", { [F.r1Switch.email]: "sw@yale.edu" })],
    }, SOURCE);
    expect(rows.find((r) => r.source.recordId === "recN")!.applicantType).toBe("NEW");
    expect(rows.find((r) => r.source.recordId === "recR")!.applicantType).toBe("RENEWAL");
    expect(rows.find((r) => r.source.recordId === "recS")!.applicantType).toBe("TRANSFER");
  });

  it("never sets a netId, because FA24 has no NetID field", () => {
    const [row] = transformVolunteerFa24({
      ...empty, r1New: [rec("recN", { [F.r1New.email]: "a@yale.edu" })],
    }, SOURCE);
    expect(row.identity.netId).toBeNull();
  });

  it("derives FINAL_ROUND by matching email into [R2] All, since there are no links", () => {
    const [row] = transformVolunteerFa24({
      ...empty,
      r1New: [rec("recN", { [F.r1New.email]: "Ada@Yale.edu" })],
      r2All: [rec("recR2", { [F.r2All.email]: "ada@yale.edu" })],
    }, SOURCE);
    expect(row.furthestStage).toBe("FINAL_ROUND");
  });

  it("derives ONBOARDED from the Final Decisions Onboarded checkbox", () => {
    const [row] = transformVolunteerFa24({
      ...empty,
      r1New: [rec("recN", { [F.r1New.email]: "ada@yale.edu" })],
      finalDecisions: [rec("recFD", {
        [F.finalDecisions.email]: "ada@yale.edu",
        [F.finalDecisions.onboarded]: true,
        [F.finalDecisions.status]: "Accepted",
        [F.finalDecisions.department]: "BVHD",
      })],
    }, SOURCE);
    expect(row.furthestStage).toBe("ONBOARDED");
    expect(row.outcome).toBe("ACCEPTED");
    expect(row.resultDepartmentRaw).toBe("BVHD");
  });

  it("marks rows sourced from the Ineligible table as INELIGIBLE", () => {
    const [row] = transformVolunteerFa24({
      ...empty, r1Ineligible: [rec("recI", { [F.r1Ineligible.email]: "no@yale.edu" })],
    }, SOURCE);
    expect(row.outcome).toBe("INELIGIBLE");
  });

  it("emits Non-Yale rows too, since a non-Yale applicant is still demonstrated interest", () => {
    const [row] = transformVolunteerFa24({
      ...empty, nonYale: [rec("recNY", { [F.nonYale.email]: "outside@gmail.com" })],
    }, SOURCE);
    expect(row.identity.email).toBe("outside@gmail.com");
  });

  it("skips rows with no email, which are Airtable cruft", () => {
    expect(transformVolunteerFa24({ ...empty, r1New: [rec("recN", {})] }, SOURCE)).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails, then implement FA24**

```bash
npx vitest run src/platform/airtable/import/history/adapters/volunteer-fa24.test.ts
```

Implementation shape:

```ts
export function transformVolunteerFa24(
  tables: Record<string, AirtableRecord[]>,
  source: HistorySource,
): RawHistoryRow[] {
  const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : null);

  // No link fields anywhere in this base, so downstream membership is an
  // email join. Both sides are lowercased before comparison.
  const reachedR2 = new Set(
    (tables.r2All ?? []).map((r) => lower(r.fields[FA24_FIELDS.r2All.email])).filter(Boolean),
  );
  const decisions = new Map(
    (tables.finalDecisions ?? [])
      .map((r) => [lower(r.fields[FA24_FIELDS.finalDecisions.email]), r] as const)
      .filter(([email]) => Boolean(email)),
  );

  const rows: RawHistoryRow[] = [];
  for (const { key, applicantType, forcedOutcome } of FA24_R1_TABLES) {
    const fields = FA24_FIELDS[key as keyof typeof FA24_FIELDS] as Record<string, string | null>;
    for (const record of tables[key] ?? []) {
      const email = typeof record.fields[fields.email!] === "string"
        ? (record.fields[fields.email!] as string).trim() : null;
      if (!email) continue;
      const key2 = email.toLowerCase();
      const decision = decisions.get(key2);
      const onboarded = decision?.fields[FA24_FIELDS.finalDecisions.onboarded] === true;
      const decisionRaw = decision
        ? (decision.fields[FA24_FIELDS.finalDecisions.status] as string | undefined) ?? null
        : null;
      const outcome = forcedOutcome ?? parseOutcome(decisionRaw);
      rows.push({
        source: { baseId: source.baseId, tableId: source.tables[key], recordId: record.id },
        cycle: { code: source.code, label: source.label, track: source.track, termCode: source.termCode },
        identity: {
          firstName: fields.first ? (record.fields[fields.first] as string) ?? "" : "",
          lastName: fields.last ? (record.fields[fields.last] as string) ?? "" : "",
          email,
          netId: null, // FA24 records no NetID anywhere.
        },
        applicantType,
        departmentChoicesRaw: [
          fields.dept1 ? (record.fields[fields.dept1] as string) ?? null : null,
          fields.dept2 ? (record.fields[fields.dept2] as string) ?? null : null,
        ],
        resultDepartmentRaw: decision
          ? (decision.fields[FA24_FIELDS.finalDecisions.department] as string) ?? null : null,
        furthestStage: deriveStage({
          advanced: reachedR2.has(key2),
          finalRound: reachedR2.has(key2),
          accepted: outcome === "ACCEPTED" || onboarded,
          onboarded,
        }),
        outcome,
        submittedAt: null,
        decidedAt: null,
        unmapped: null,
      });
    }
  }
  return rows;
}
```

- [ ] **Step 4: Write the SU26 adapter**

Good news: **V-SU26 needs only the Applicants table.** It carries link fields to its own downstream tables, exactly like the modern volunteer lineage, so `volunteer-su26.ts` mirrors Task 6 closely. Verified ids on `tblV3UrQQvIIZzFTU`:

```ts
export const SU26_FIELDS = {
  firstName: "fldiZWK1yycg5rwB3",
  lastName: "fldwLgLBjxGr6NYvy",
  /**
   * PRIMARY email source: a formula, populated on all 358 rows. Read this
   * FIRST. The direct `email` field below is populated on only 161, because
   * returning members link an existing record instead of retyping their
   * address. Reading only the direct field would drop 197 of 358 applicants
   * as contactless cruft. Verified 2026-08-05:
   *   Primary Email 358/358, Email 161/358, email from record 204/358.
   */
  primaryEmail: "fldpyzUIOubXWqrQ3",
  email: "fldA2aimGltA8NX1G",
  netId: "fldaDUQ4PIQuzUVT8",
  dept1: "fldQvDs0wg4EDTMLo",
  dept2: "fldMD1njjyNSvRR0f",
  acceptances: "fldpu3cmprXapSnoq",   // link to tblc15YeGhahLxeA9
  contracts: "flds0n3Hue8Xin9h8",     // link to tblW5qmRckmvz1QGX
  acceptedDept: "fldA8Afm5itWGOf7U",  // lookup
  submittedAt: "fld0l5nof6dzVkDmM",   // createdTime
} as const;
```

Resolve the email as `flat(f[F.primaryEmail]) ?? str(f[F.email])`, where `flat` unwraps a single-element array (formula and lookup cells can arrive either way). `accepted` is a non-empty `acceptances` link, `onboarded` a non-empty `contracts` link, and `submittedAt` parses the createdTime string into a `Date`.

Test the same behaviors as Task 6 (identity mapping, NetID rejection, accepted, onboarded, department order, cruft skipping) PLUS these two, which guard the 197-row drop:

```ts
it("reads the formula Primary Email when the direct Email field is empty", () => {
  // 197 of SU26's 358 rows look exactly like this.
  const [row] = transformVolunteerSu26({
    applicants: [record("rec1", { [F.primaryEmail]: "linked@yale.edu" })],
  }, SOURCE);
  expect(row).toBeDefined();
  expect(row.identity.email).toBe("linked@yale.edu");
});

it("unwraps a single-element array from the formula cell", () => {
  const [row] = transformVolunteerSu26({
    applicants: [record("rec1", { [F.primaryEmail]: ["boxed@yale.edu"] })],
  }, SOURCE);
  expect(row.identity.email).toBe("boxed@yale.edu");
});
```

- [ ] **Step 5: Write the interest-form adapter**

`interest-form.ts` emits `RawInterestRow` only and reads both tables, since the old MS table holds 757 of the 1,104 rows. Verified ids:

```ts
export const INTEREST_FIELDS = {
  responses:    { name: "fldgfooA8WuUX5y8B", email: "fldmPa8oFkr7LHQYT" },
  responsesOld: { name: "fldHaLthl8UqnJyRI", email: "fldNKxd5SwRDblQH0" },
} as const;
```

Both tables carry a single `Name` field rather than first and last, so split on the first space: everything before it is the first name, the remainder is the last name, and a single-token name becomes the first name with an empty last name. Test both tables being read, the name split (including the single-token case), and that a row with no email is skipped.

- [ ] **Step 6: Run all adapter tests**

```bash
npx vitest run src/platform/airtable/import/history/adapters/
```

- [ ] **Step 7: Commit**

```bash
git add src/platform/airtable/import/history/adapters
git commit -m "feat(recruitment): add the FA24, SU26 and interest-form history adapters"
```

---

## Task 9: Load and report

**Files:**
- Create: `src/platform/airtable/import/history/load.ts`
- Create: `src/platform/airtable/import/history/report.ts`
- Test: `src/platform/airtable/import/history/load.test.ts`

**Interfaces:**
- Consumes: `RawHistoryRow`, `RawInterestRow`, `resolveIdentities`, `resolveDepartmentCodes`.
- Produces:
  - `type ImportReport = { dryRun: boolean; perSource: Array<{ code: string; rows: number; byStage: Record<string, number>; byOutcome: Record<string, number> }>; identities: { rows: number; resolved: number; multiCycle: number }; unmappedDepartments: string[]; unmappedDecisions: string[]; rejectedNetIds: Array<{ recordId: string; value: string }> }`
  - `loadHistory(rows: RawHistoryRow[], interests: RawInterestRow[], opts: { dryRun: boolean }): Promise<ImportReport>`
  - `formatReport(report: ImportReport): string`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { loadHistory } from "./load";
import type { RawHistoryRow } from "./types";

const row = (recordId: string, email: string, over: Partial<RawHistoryRow> = {}): RawHistoryRow => ({
  source: { baseId: "appTest", tableId: "tblTest", recordId },
  cycle: { code: "V-FA25", label: "Fall 2025 Volunteer Recruitment", track: "VOLUNTEER", termCode: "FA25" },
  identity: { firstName: "Ada", lastName: "Lovelace", email, netId: null },
  applicantType: null, departmentChoicesRaw: ["BVHD"], resultDepartmentRaw: null,
  furthestStage: "APPLIED", outcome: "NO_DECISION",
  submittedAt: null, decidedAt: null, unmapped: null,
  ...over,
});

beforeEach(async () => {
  await prisma.historicalApplication.deleteMany();
  await prisma.historicalInterest.deleteMany();
  await prisma.historicalApplicantEmail.deleteMany();
  await prisma.historicalApplicant.deleteMany();
});

describe("loadHistory", () => {
  it("writes nothing when dryRun is true", async () => {
    await loadHistory([row("rec1", "a@yale.edu")], [], { dryRun: true });
    expect(await prisma.historicalApplicant.count()).toBe(0);
  });

  it("writes an applicant, an email and an application", async () => {
    await loadHistory([row("rec1", "a@yale.edu")], [], { dryRun: false });
    expect(await prisma.historicalApplicant.count()).toBe(1);
    expect(await prisma.historicalApplicantEmail.count()).toBe(1);
    expect(await prisma.historicalApplication.count()).toBe(1);
  });

  it("is idempotent: running twice yields identical counts", async () => {
    const rows = [row("rec1", "a@yale.edu"), row("rec2", "b@yale.edu")];
    await loadHistory(rows, [], { dryRun: false });
    const first = await prisma.historicalApplication.count();
    await loadHistory(rows, [], { dryRun: false });
    expect(await prisma.historicalApplication.count()).toBe(first);
    expect(await prisma.historicalApplicant.count()).toBe(2);
  });

  it("updates a changed row in place rather than duplicating it", async () => {
    await loadHistory([row("rec1", "a@yale.edu")], [], { dryRun: false });
    await loadHistory([row("rec1", "a@yale.edu", { furthestStage: "ACCEPTED", outcome: "ACCEPTED" })], [], { dryRun: false });
    const all = await prisma.historicalApplication.findMany();
    expect(all).toHaveLength(1);
    expect(all[0].furthestStage).toBe("ACCEPTED");
  });

  it("groups two cycles for one person under a single applicant", async () => {
    await loadHistory([
      row("rec1", "a@yale.edu"),
      row("rec2", "a@yale.edu", { cycle: { code: "V-SP25", label: "Spring 2025 Volunteer Recruitment", track: "VOLUNTEER", termCode: "SP25" } }),
    ], [], { dryRun: false });
    expect(await prisma.historicalApplicant.count()).toBe(1);
    expect(await prisma.historicalApplication.count()).toBe(2);
  });

  it("links to a Person when the email matches, and leaves personId null otherwise", async () => {
    const person = await prisma.person.create({
      data: { name: "Ada Lovelace", contactEmail: "a@yale.edu" },
    });
    await loadHistory([row("rec1", "a@yale.edu"), row("rec2", "z@yale.edu")], [], { dryRun: false });
    const linkedRow = await prisma.historicalApplicant.findFirst({ where: { primaryEmail: "a@yale.edu" } });
    const unlinked = await prisma.historicalApplicant.findFirst({ where: { primaryEmail: "z@yale.edu" } });
    expect(linkedRow!.personId).toBe(person.id);
    expect(unlinked!.personId).toBeNull();
  });

  it("reports unmapped department labels instead of coercing them", async () => {
    const report = await loadHistory(
      [row("rec1", "a@yale.edu", { departmentChoicesRaw: ["Not A Real Dept"] })],
      [], { dryRun: true },
    );
    expect(report.unmappedDepartments).toContain("Not A Real Dept");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
export TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_rechistory"
npx vitest run src/platform/airtable/import/history/load.test.ts
```

- [ ] **Step 3: Implement `load.ts`**

Order of operations, which matters:

1. Build `IdentityInput[]` from every application row and interest row, using `source.recordId` as `key`.
2. `resolveIdentities` once over the combined list.
3. Load `Department.code` into a `Set` for `resolveDepartmentCodes`.
4. Load candidate `Person` rows by netId and by `contactEmail` in two `findMany` calls (never one query per row).
5. If `dryRun`, build and return the report without writing.
6. Otherwise, in a transaction per identity: upsert `HistoricalApplicant` (by `netId` when present, else by joining through `HistoricalApplicantEmail.email`), upsert its emails, then upsert each application and interest keyed on the three source columns.

- [ ] **Step 4: Implement `report.ts`**

`formatReport` returns a plain-text block: a per-source table, the identity summary, then the three "needs a human" lists (unmapped departments, unmapped decisions, rejected NetIDs). An empty list prints as "none".

- [ ] **Step 5: Run and confirm the tests pass**

```bash
npx vitest run src/platform/airtable/import/history/load.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/platform/airtable/import/history/load.ts src/platform/airtable/import/history/report.ts src/platform/airtable/import/history/load.test.ts
git commit -m "feat(recruitment): load historical rows idempotently and report the dry run"
```

---

## Task 10: The CLI entry point

**Files:**
- Create: `scripts/import-history.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `HISTORY_SOURCES`, every adapter, `loadHistory`, `formatReport`, `AirtableClient`.
- Produces: the `import:history:dry` and `import:history:apply` npm scripts.

- [ ] **Step 1: Read the existing script for the house pattern**

```bash
cat scripts/import-historical-term.ts
```

Match its argument parsing, its `AIRTABLE_PAT` guard, and its exit codes.

- [ ] **Step 2: Write the script**

It fetches every table named in each source's `tables` map via `AirtableClient.listAll`, dispatches on `source.adapter`, concatenates the rows, calls `loadHistory` with `dryRun: !process.argv.includes("--apply")`, and prints `formatReport`.

Guard, mirroring the existing importers:

```ts
if (!process.env.AIRTABLE_PAT) {
  console.error("AIRTABLE_PAT is not set in .env; the importer needs read access.");
  process.exit(1);
}
```

- [ ] **Step 3: Add the npm scripts**

```json
"import:history:dry": "tsx --env-file=.env scripts/import-history.ts",
"import:history:apply": "tsx --env-file=.env scripts/import-history.ts --apply"
```

- [ ] **Step 4: Run the dry run against real Airtable**

```bash
npm run import:history:dry
```

Expected: a report totalling about 3,531 application rows and 1,104 interest rows across 11 sources, writing nothing. Read the unmapped-department and unmapped-decision lists carefully. If either is long, fix the mapping before proceeding rather than accepting the loss.

- [ ] **Step 5: Commit**

```bash
git add scripts/import-history.ts package.json
git commit -m "feat(recruitment): add the history import CLI"
```

---

## Task 11: The history read service

**Files:**
- Create: `src/modules/recruitment/services/history.ts`
- Test: `src/modules/recruitment/services/history.test.ts`

**Interfaces:**
- Consumes: `stageLabel` (Task 2), the Prisma models (Task 1).
- Produces:
  - `type HistoryEntry = { kind: "application" | "interest"; era: "archive" | "live"; cycleCode: string; cycleLabel: string; track: Track; departmentCodes: string[]; resultDepartment: string | null; furthestStage: HistoricalStage | null; outcome: HistoricalOutcome | null; occurredAt: Date | null; href: string | null }`
  - `type ApplicantHistory = { entries: HistoryEntry[]; applicationCount: number; furthest: { stage: HistoricalStage; cycleLabel: string } | null }`
  - `getApplicantHistory(q: { netId?: string | null; emails: string[]; personId?: string | null; excludeApplicationId?: string }): Promise<ApplicantHistory>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { getApplicantHistory } from "./history";

beforeEach(async () => {
  await prisma.historicalApplication.deleteMany();
  await prisma.historicalApplicantEmail.deleteMany();
  await prisma.historicalApplicant.deleteMany();
});

async function seedArchive(email: string) {
  const applicant = await prisma.historicalApplicant.create({
    data: {
      primaryEmail: email, firstName: "Ada", lastName: "Lovelace",
      emails: { create: [{ email }] },
    },
  });
  await prisma.historicalApplication.create({
    data: {
      applicantId: applicant.id,
      sourceBaseId: "appT", sourceTableId: "tblT", sourceRecordId: "rec1",
      cycleCode: "V-FA25", cycleLabel: "Fall 2025 Volunteer Recruitment",
      track: "VOLUNTEER", termCode: "FA25",
      departmentChoices: ["BVHD"], furthestStage: "FINAL_ROUND", outcome: "REJECTED",
    },
  });
  return applicant;
}

/**
 * Seeds two live-era applications for one person in two different cycles.
 * Needed by the exclusion test: with only one application, asserting "the
 * current one is absent" passes vacuously on an empty list.
 *
 * Build the Term, Department, RecruitmentCycle, Applicant and Application
 * rows this needs with the project's existing test helpers if any exist
 * (check e2e/fixtures and any src/**\/*.test-helpers.ts before hand-rolling);
 * both cycles must share one Applicant row keyed on emailLower.
 */
async function seedTwoLiveApplications(email: string): Promise<{
  current: { id: string; cycleId: string };
  sibling: { id: string; cycleId: string };
}> {
  throw new Error("implement per the doc comment above");
}

describe("getApplicantHistory", () => {
  it("finds archive entries by email, case-insensitively", async () => {
    await seedArchive("ada@yale.edu");
    const h = await getApplicantHistory({ emails: ["Ada@Yale.edu"] });
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0].era).toBe("archive");
    expect(h.entries[0].cycleLabel).toBe("Fall 2025 Volunteer Recruitment");
  });

  it("returns an empty history rather than throwing for an unknown applicant", async () => {
    const h = await getApplicantHistory({ emails: ["nobody@yale.edu"] });
    expect(h.entries).toEqual([]);
    expect(h.applicationCount).toBe(0);
    expect(h.furthest).toBeNull();
  });

  it("reports the furthest stage across all entries", async () => {
    const applicant = await seedArchive("ada@yale.edu");
    await prisma.historicalApplication.create({
      data: {
        applicantId: applicant.id,
        sourceBaseId: "appT", sourceTableId: "tblT", sourceRecordId: "rec2",
        cycleCode: "V-SP25", cycleLabel: "Spring 2025 Volunteer Recruitment",
        track: "VOLUNTEER", termCode: "SP25",
        departmentChoices: [], furthestStage: "APPLIED", outcome: "REJECTED",
      },
    });
    const h = await getApplicantHistory({ emails: ["ada@yale.edu"] });
    expect(h.applicationCount).toBe(2);
    expect(h.furthest!.stage).toBe("FINAL_ROUND");
    expect(h.furthest!.cycleLabel).toBe("Fall 2025 Volunteer Recruitment");
  });

  it("matches on netId even when the email differs", async () => {
    await prisma.historicalApplicant.create({
      data: {
        netId: "al123", primaryEmail: "old@yale.edu", firstName: "Ada", lastName: "Lovelace",
        emails: { create: [{ email: "old@yale.edu" }] },
        applications: {
          create: [{
            sourceBaseId: "appT", sourceTableId: "tblT", sourceRecordId: "recX",
            cycleCode: "V-SU25", cycleLabel: "Summer 2025 Volunteer Recruitment",
            track: "VOLUNTEER", termCode: "SU25",
            departmentChoices: [], furthestStage: "APPLIED", outcome: "REJECTED",
          }],
        },
      },
    });
    const h = await getApplicantHistory({ netId: "al123", emails: ["brand-new@gmail.com"] });
    expect(h.entries).toHaveLength(1);
  });

  it("excludes the application currently being viewed but keeps its siblings", async () => {
    // Live-era exclusion: the reviewer card must not list the page it is on.
    // Two live applications are seeded so the assertion distinguishes real
    // exclusion from an empty result set.
    const { current, sibling } = await seedTwoLiveApplications("ada@yale.edu");

    const h = await getApplicantHistory({
      emails: ["ada@yale.edu"],
      excludeApplicationId: current.id,
    });

    const liveIds = h.entries.filter((e) => e.era === "live").map((e) => e.href);
    expect(liveIds).toContain(`/recruitment/cycles/${sibling.cycleId}/applicants/${sibling.id}`);
    expect(liveIds).not.toContain(`/recruitment/cycles/${current.cycleId}/applicants/${current.id}`);
  });

  it("includes interest-form entries, distinctly from applications", async () => {
    const applicant = await seedArchive("ada@yale.edu");
    await prisma.historicalInterest.create({
      data: {
        applicantId: applicant.id,
        sourceBaseId: "appyZMpXNJ0rVzOT8", sourceTableId: "tblEacqiHtqKMJphX", sourceRecordId: "recI1",
        submittedAt: new Date("2024-09-01T00:00:00Z"),
      },
    });
    const h = await getApplicantHistory({ emails: ["ada@yale.edu"] });
    const interest = h.entries.find((e) => e.kind === "interest");
    expect(interest).toBeDefined();
    expect(interest!.furthestStage).toBeNull();
    expect(interest!.outcome).toBeNull();
    // An interest submission is not an application and must not inflate the count.
    expect(h.applicationCount).toBe(1);
  });

  it("sorts entries newest first", async () => {
    const applicant = await seedArchive("ada@yale.edu");
    await prisma.historicalInterest.create({
      data: {
        applicantId: applicant.id,
        sourceBaseId: "appyZMpXNJ0rVzOT8", sourceTableId: "tblEacqiHtqKMJphX", sourceRecordId: "recI1",
        submittedAt: new Date("2020-01-01T00:00:00Z"),
      },
    });
    const h = await getApplicantHistory({ emails: ["ada@yale.edu"] });
    expect(h.entries[h.entries.length - 1].kind).toBe("interest");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run src/modules/recruitment/services/history.test.ts
```

- [ ] **Step 3: Implement**

Resolve the matching `HistoricalApplicant` rows in one query: `where: { OR: [{ netId }, { emails: { some: { email: { in: lowercasedEmails } } } }] }`, including both `applications` and `interests`. Map applications to `kind: "application"` entries and interests to `kind: "interest"` entries, where an interest carries `furthestStage: null` and `outcome: null` because it has no funnel position.

Query live rows via `Applicant` on the same keys, including `applications` with their `interviews` and `acceptances`, and map each through a local `liveEntry()` helper that calls `deriveStage` with signals read from the live models: `advanced` when an interview row exists, `finalRound` likewise, `accepted` when an `Acceptance` exists, `onboarded` when its `OnboardingContract.status === "PROMOTED"`. Drop any live application whose id equals `excludeApplicationId`.

`applicationCount` counts only `kind === "application"` entries, so an interest submission never inflates "3rd application". `furthest` is computed over application entries alone, using the enum's own ordering rather than string comparison. Sort every entry by `occurredAt` descending with nulls last.

- [ ] **Step 4: Run and confirm it passes**

```bash
npx vitest run src/modules/recruitment/services/history.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/history.ts src/modules/recruitment/services/history.test.ts
git commit -m "feat(recruitment): union archive and live applications into one history"
```

---

## Task 12: The history component and the reviewer card

**Files:**
- Create: `src/modules/recruitment/components/applicant-history.tsx`
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`

**Interfaces:**
- Consumes: `ApplicantHistory` (Task 11), `stageLabel` (Task 2).
- Produces: `<ApplicantHistory history={...} title={...} />`, a server component.

- [ ] **Step 1: Build the component**

Use the existing primitives only: `Card`, `SectionHeader`, `Badge`, and `DateTime` from `@/platform/dates/display`. Do not introduce new styling utilities and never use `tailwind-merge`.

Render the summary line first (`"3rd application. Furthest: Round 2 (Fall 2025)."`), then one row per entry showing cycle label, track, department codes, and `stageLabel` plus outcome. Interest entries render with just a date and the words "Interest form".

The empty state renders the card with "First application, no earlier record." A missing card would be ambiguous between "new applicant" and "failed to load".

- [ ] **Step 2: Mount it on the reviewer page**

In the detail page, after `getApplication` resolves, add to the existing `Promise.all`:

```ts
getApplicantHistory({
  netId: app.applicant.netId,
  emails: [app.applicant.email],
  excludeApplicationId: applicationId,
}),
```

Render `<ApplicantHistory history={history} title="Past applications" />` directly below `<PageHeader>` and above the `sections.map(...)` block.

No new permission check: the page's existing `canViewApplication` gate already governs who can see this applicant at all.

- [ ] **Step 3: Verify in the running app**

```bash
npm run dev
```

Open a cycle applicant with known prior history and confirm the card lists it. Confirm an applicant with no history shows the empty state.

- [ ] **Step 4: Lint and typecheck**

```bash
npx eslint src e2e
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/components/applicant-history.tsx "src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx"
git commit -m "feat(recruitment): show past applications on the reviewer page"
```

---

## Task 13: The person profile section and the history browser

**Files:**
- Modify: `src/app/(app)/admin/people/[id]/page.tsx`
- Create: `src/app/(app)/recruitment/history/page.tsx`
- Create: `src/app/(app)/recruitment/history/[applicantId]/page.tsx`
- Modify: `src/platform/modules/registry.ts`

- [ ] **Step 1: Mount the section on the person page**

Call `getApplicantHistory({ netId: person.netId, emails: [person.contactEmail].filter(Boolean), personId: person.id })` and render `<ApplicantHistory history={history} title="Recruitment history" />` below the memberships panel. The page's existing `admin.manage_people` gate governs access.

- [ ] **Step 2: Build the browser page**

A server component gated with `requirePermission("recruitment.access")`. It takes a `q` search param and queries `HistoricalApplicant` on name, `primaryEmail`, related `emails.email`, and `netId`, all case-insensitive, capped at 50 results with a count of the total.

Use `NavForm` for the search field, never a bare `<form GET>`, or the filter will trigger a full page reload instead of a soft navigation.

Each result links to `/recruitment/history/[applicantId]`.

- [ ] **Step 3: Build the detail page**

Same permission gate. Renders the person's name, every known email, the linked `Person` when `personId` is set, and `<ApplicantHistory />` for the full timeline.

- [ ] **Step 4: Add the nav item**

In `src/platform/modules/registry.ts`, add `{ label: "History", href: "/recruitment/history" }` to the recruitment module's `nav` array. Keep the label short: the nav row has a real width budget at 1280px that only the e2e test enforces.

- [ ] **Step 5: Verify, lint, typecheck**

```bash
npm run dev   # exercise search, click into a detail page
npx eslint src e2e
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/admin/people/[id]/page.tsx" "src/app/(app)/recruitment/history" src/platform/modules/registry.ts
git commit -m "feat(recruitment): add the history browser and person profile section"
```

---

## Task 14: End-to-end coverage and the full verification pass

**Files:**
- Create: `e2e/recruitment-history.spec.ts`

- [ ] **Step 1: Read an existing spec for the fixture pattern**

```bash
ls e2e/
```

Reuse the shared fixtures. The suite runs `workers: 1` and serially, so do not add parallel-unsafe setup.

- [ ] **Step 2: Write the spec**

Two flows: the history browser finds a seeded applicant by email and opens their detail page; and the reviewer page shows a "Past applications" card for an applicant seeded with a prior cycle.

Anchor any text assertion that could match a substring. Use `/^Accepted$/` rather than `has-text("Accepted")`, which would also match "Accepted?" and similar labels.

- [ ] **Step 3: Run the full unit suite**

```bash
export TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_rechistory"
export BLOB_READ_WRITE_TOKEN=""
npm test
```

Expected: all pass. The pre-change baseline was 342 files / 3944 tests / 0 failures, so the count should be higher and failures still zero.

- [ ] **Step 4: Lint and typecheck**

```bash
npx eslint src e2e
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add e2e/recruitment-history.spec.ts
git commit -m "test(recruitment): cover the history browser and reviewer card end to end"
```

---

## Task 15: Production import

**Not code. Do not start until Tasks 1 to 14 are merged and deployed.**

- [ ] **Step 1: Confirm the migration is live**

```bash
npx prisma migrate status
```

Preview deploys share the production database, so a branch behind this migration crashes with P2021. The migration must be deployed before the UI is.

- [ ] **Step 2: Dry run against production**

```bash
npm run import:history:dry
```

- [ ] **Step 3: Review the report with ops**

Specifically: does the identity count look plausible against roughly 4,635 source rows, are the unmapped-department and unmapped-decision lists short, and does any cycle's stage distribution look obviously wrong? V-SP26 legitimately shows only APPLIED and ACCEPTED.

- [ ] **Step 4: Apply**

```bash
npm run import:history:apply
```

- [ ] **Step 5: Spot check**

Open `/recruitment/history`, search for a person known to have applied more than once, and confirm the timeline matches Airtable.
