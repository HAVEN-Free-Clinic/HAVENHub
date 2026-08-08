# Recruitment Onboarding Bulk Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-form onboarding page with a single filterable table whose selection drives bulk Send links, Promote, and Withdraw.

**Architecture:** Pure helpers (row state, eligibility, filtering, custom-answer resolution) live in `src/modules/recruitment/engine` and `contract`. The service projects acceptances into a narrow `OnboardingRow` DTO that omits the onboarding token and applicant PII. A client component owns filter and selection state and renders one `<form>`; its checkboxes are the form inputs. Three server actions all take the same `acceptanceId[]` payload and re-derive eligibility from the database.

**Tech Stack:** Next.js 16 App Router (React 19.2), Prisma 6, Vitest 4, Playwright.

## Global Constraints

- **No em-dash (U+2014) anywhere in `src/**/*.{ts,tsx}`.** CI-enforced by the `local/no-em-dash` eslint rule. Use a comma, colon, parentheses, or hyphen.
- **No `Date.now()` or `new Date()` in client render.** Expiry is derived on the server and passed in as a resolved `state`.
- **Modules never import other modules.** `src/modules/recruitment/**` may import `@/platform/**` but not `@/modules/<other>/**`.
- **No styled raw controls.** Use `Button`, `Input`, `Select`, `Checkbox` from `@/platform/ui`. A `className` on a raw `button`/`input`/`select`/`textarea` is an eslint error.
- **Test runs need an explicit database URL.** Prefix every vitest command with
  `TEST_DATABASE_URL='postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_bulkactions' BLOB_READ_WRITE_TOKEN=''`
  This worktree owns that database. Without it, tests contend with other worktrees and fail spuriously.
- **Never trust client-supplied eligibility.** Every server action re-reads state from the database and scopes every query to the cycle in the URL.
- **A submit button cannot have BOTH `formAction={fn}` and a `name`/`value`.** React 19 drops the button's name/value in that case: in `react-dom-client`, when the submitter carries its own `formAction`, React adopts that action and then sets `submitter = null`, so `createFormDataWithSubmitter` never runs and the pair never reaches the FormData. A button that must submit its own `name`/`value` therefore has to ride the form's default `action`. This is why `withdraw` is the `<form action>` and only `sendLinks`/`promote` use `formAction`. Discovered during Task 5 and verified against the React source.

## Shared test seeding

Tasks 3, 4, and 7 are database-backed and all need the same fixture. **Task 3
creates this module; Tasks 4 and 7 import it.** It is a test-only helper living
in `src`, mirroring the existing `@/platform/test/db` precedent, and its filename
does not match vitest's `src/**/*.test.ts` include pattern so it is never
collected as a suite of its own.

Create at `src/modules/recruitment/test/seed-cycle.ts`:

```ts
import { prisma } from "@/platform/db";

type ContractSeed = {
  status: "PENDING" | "SUBMITTED" | "PROMOTED";
  expiresAt?: Date | null;
  promotedPersonId?: string | null;
  templateSnapshot?: object | null;
  customAnswers?: object | null;
};

/**
 * Seed one cycle with a caller-described set of acceptances.
 *
 * Each entry becomes an applicant, an application, and an acceptance in the
 * given department, plus an OnboardingContract when `contract` is set. Two
 * entries sharing an `applicationKey` attach to the SAME application, which is
 * how a conflicted acceptance (accepted by more than one department) is built.
 */
export async function seedCycle(entries: Array<{
  applicationKey?: string;
  dept?: "SRHD" | "PCAR";
  firstName?: string;
  lastName?: string;
  contract?: ContractSeed;
}>) {
  const term = await prisma.term.create({ data: {
    code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE",
  } });
  await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  await prisma.department.create({ data: { code: "PCAR", name: "PCAR" } });

  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: {
    name: "Rec Admin", grants: { create: [{ permission: "recruitment.review_all" }] },
  } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  // A person with no recruitment permission, for authorization tests.
  const plain = await prisma.person.create({ data: { name: "Nobody", status: "ACTIVE" } });

  const cycle = await prisma.recruitmentCycle.create({ data: {
    track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v",
    departments: ["SRHD", "PCAR"], createdById: srr.id, status: "OPEN",
  } });

  const applicationsByKey = new Map<string, string>();
  const acceptances: { id: string; contractId: string | null }[] = [];

  for (const [i, e] of entries.entries()) {
    const key = e.applicationKey ?? `app-${i}`;
    let applicationId = applicationsByKey.get(key);
    if (!applicationId) {
      const applicant = await prisma.applicant.create({ data: {
        cycleId: cycle.id,
        firstName: e.firstName ?? `First${i}`,
        lastName: e.lastName ?? `Last${i}`,
        email: `applicant${i}@yale.edu`,
        emailLower: `applicant${i}@yale.edu`,
        netId: `net${i}`,
      } });
      const application = await prisma.application.create({ data: {
        cycleId: cycle.id, applicantId: applicant.id, answers: {},
        applicantType: "NEW", departmentChoices: ["SRHD"],
      } });
      applicationId = application.id;
      applicationsByKey.set(key, applicationId);
    }

    const acceptance = await prisma.acceptance.create({ data: {
      applicationId, departmentCode: e.dept ?? "SRHD", approvedById: srr.id,
    } });

    let contractId: string | null = null;
    if (e.contract) {
      const c = await prisma.onboardingContract.create({ data: {
        acceptanceId: acceptance.id,
        token: `tok-${i}-${acceptance.id}`,
        status: e.contract.status,
        firstName: e.firstName ?? `First${i}`,
        lastName: e.lastName ?? `Last${i}`,
        email: `applicant${i}@yale.edu`,
        expiresAt: e.contract.expiresAt ?? null,
        promotedPersonId: e.contract.promotedPersonId ?? null,
        templateSnapshot: e.contract.templateSnapshot ?? undefined,
        customAnswers: e.contract.customAnswers ?? undefined,
        submittedAt: e.contract.status === "PENDING" ? null : new Date(),
      } });
      contractId = c.id;
    }
    acceptances.push({ id: acceptance.id, contractId });
  }

  return { cycleId: cycle.id, srrId: srr.id, plainId: plain.id, acceptances };
}
```

Each of the three test files then opens with its own reset hooks, which stay
per-file because that IS the repo convention and they carry no logic:

```ts
import { afterEach, beforeEach } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { seedCycle } from "@/modules/recruitment/test/seed-cycle";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });
```

---

### Task 1: Custom answer resolution helper

Extracts the 30-line IIFE currently embedded in the onboarding page's JSX into a tested pure function. It resolves each stored answer key against the contract's frozen `templateSnapshot`, which drops internal `confirm__<agreementId>` agreement keys and stale answers to questions this contract never showed.

**Files:**
- Create: `src/modules/recruitment/contract/custom-answers.ts`
- Test: `src/modules/recruitment/contract/custom-answers.test.ts`

**Interfaces:**
- Consumes: `parseContractLayout` from `src/modules/recruitment/contract/layout.ts` (throws on an invalid snapshot).
- Produces: `resolveCustomAnswers(templateSnapshot: unknown, customAnswers: unknown): { label: string; value: string }[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { resolveCustomAnswers } from "./custom-answers";

const snapshot = {
  blocks: [
    { kind: "custom_question", key: "tshirt", label: "T-shirt size", fieldType: "text" },
    { kind: "agreement", id: "strike_policy", title: "Strikes", body: "x", confirmKind: "checkbox", signatureLabel: "confirm" },
  ],
};

describe("resolveCustomAnswers", () => {
  it("labels a custom question from the snapshot", () => {
    expect(resolveCustomAnswers(snapshot, { tshirt: "M" })).toEqual([
      { label: "T-shirt size", value: "M" },
    ]);
  });

  it("drops internal agreement-confirmation keys", () => {
    expect(resolveCustomAnswers(snapshot, { confirm__strike_policy: "on" })).toEqual([]);
  });

  it("drops an answer to a question the snapshot never showed", () => {
    expect(resolveCustomAnswers(snapshot, { removed_question: "stale" })).toEqual([]);
  });

  it("joins a multi-value answer", () => {
    expect(resolveCustomAnswers(snapshot, { tshirt: ["M", "L"] })).toEqual([
      { label: "T-shirt size", value: "M, L" },
    ]);
  });

  it("drops empty and nullish answers", () => {
    expect(resolveCustomAnswers(snapshot, { tshirt: "" })).toEqual([]);
    expect(resolveCustomAnswers(snapshot, { tshirt: null })).toEqual([]);
  });

  it("returns nothing when the snapshot is missing or invalid", () => {
    expect(resolveCustomAnswers(null, { tshirt: "M" })).toEqual([]);
    expect(resolveCustomAnswers({ nope: true }, { tshirt: "M" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_bulkactions' BLOB_READ_WRITE_TOKEN='' npx vitest run src/modules/recruitment/contract/custom-answers.test.ts`
Expected: FAIL, cannot resolve `./custom-answers`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { parseContractLayout } from "./layout";

/**
 * Resolve a contract's stored custom answers into displayable label/value pairs.
 *
 * Keys are matched against the custom_question blocks in the contract's frozen
 * templateSnapshot, which is what makes this safe to render: customAnswers also
 * holds internal confirm__<agreementId> checkbox-agreement keys (submitContract
 * stores them there), and can carry a stale answer to a question this contract
 * never showed. Keying off the snapshot drops both.
 */
export function resolveCustomAnswers(
  templateSnapshot: unknown,
  customAnswers: unknown,
): { label: string; value: string }[] {
  if (templateSnapshot == null) return [];
  const labels: Record<string, string> = {};
  try {
    for (const block of parseContractLayout(templateSnapshot).blocks) {
      if (block.kind === "custom_question") labels[block.key] = block.label;
    }
  } catch {
    // Invalid snapshot: show no custom answers rather than raw keys.
    return [];
  }

  const answers = (customAnswers ?? {}) as Record<string, unknown>;
  const out: { label: string; value: string }[] = [];
  for (const [key, raw] of Object.entries(answers)) {
    if (!(key in labels)) continue;
    if (raw == null || raw === "") continue;
    const value = Array.isArray(raw) ? raw.join(", ") : String(raw);
    if (value === "") continue;
    out.push({ label: labels[key], value });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_bulkactions' BLOB_READ_WRITE_TOKEN='' npx vitest run src/modules/recruitment/contract/custom-answers.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/contract/custom-answers.ts src/modules/recruitment/contract/custom-answers.test.ts
git commit -m "refactor(recruitment): extract custom answer resolution from onboarding JSX"
```

---

### Task 2: Row state and eligibility

The pure core of the feature: what state a row is in, which actions can touch it, and how filtering narrows the list. Everything here is deterministic and takes `now` as a parameter, so no clock reads happen in render.

**Files:**
- Create: `src/modules/recruitment/engine/onboarding-rows.ts`
- Test: `src/modules/recruitment/engine/onboarding-rows.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type OnboardingRowState = "NO_CONTRACT" | "SENT" | "EXPIRED" | "SUBMITTED" | "PROMOTED" | "CONFLICT"`
  - `type OnboardingBulkAction = "send" | "promote" | "withdraw"`
  - `type OnboardingRow = { acceptanceId, contractId, firstName, lastName, departmentCode, state, onRoster, customAnswers }`
  - `type OnboardingFilters = { query: string; status: OnboardingRowState | "ALL"; dept: string | "ALL" }`
  - `deriveRowState(input): OnboardingRowState`
  - `isEligible(action, state): boolean`
  - `isSelectable(state): boolean`
  - `filterRows(rows, filters): OnboardingRow[]`
  - `countEligible(rows, action): number`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import {
  deriveRowState, isEligible, isSelectable, filterRows, countEligible,
  type OnboardingRow,
} from "./onboarding-rows";

const NOW = new Date("2026-08-07T12:00:00Z");

function row(over: Partial<OnboardingRow> = {}): OnboardingRow {
  return {
    acceptanceId: "a1", contractId: "c1", firstName: "Ona", lastName: "Boarder",
    departmentCode: "SRHD", state: "SUBMITTED", onRoster: false, customAnswers: [],
    ...over,
  };
}

describe("deriveRowState", () => {
  it("reports a conflicted acceptance as CONFLICT regardless of contract state", () => {
    const contract = { status: "SUBMITTED", expiresAt: null };
    expect(deriveRowState({ conflicted: true, contract, now: NOW })).toBe("CONFLICT");
  });

  it("reports a missing contract as NO_CONTRACT", () => {
    expect(deriveRowState({ conflicted: false, contract: null, now: NOW })).toBe("NO_CONTRACT");
  });

  it("reports a live PENDING contract as SENT", () => {
    const contract = { status: "PENDING", expiresAt: new Date("2026-08-20T12:00:00Z") };
    expect(deriveRowState({ conflicted: false, contract, now: NOW })).toBe("SENT");
  });

  it("reports a lapsed PENDING contract as EXPIRED", () => {
    const contract = { status: "PENDING", expiresAt: new Date("2026-08-01T12:00:00Z") };
    expect(deriveRowState({ conflicted: false, contract, now: NOW })).toBe("EXPIRED");
  });

  // Contracts created before expiresAt existed are grandfathered as non-expiring,
  // matching isContractExpired in the service.
  it("treats a null expiry as non-expiring", () => {
    const contract = { status: "PENDING", expiresAt: null };
    expect(deriveRowState({ conflicted: false, contract, now: NOW })).toBe("SENT");
  });

  it("passes SUBMITTED and PROMOTED through", () => {
    expect(deriveRowState({ conflicted: false, contract: { status: "SUBMITTED", expiresAt: null }, now: NOW })).toBe("SUBMITTED");
    expect(deriveRowState({ conflicted: false, contract: { status: "PROMOTED", expiresAt: null }, now: NOW })).toBe("PROMOTED");
  });

  // An expired link that the applicant already submitted is not stale; expiry
  // only gates the PENDING window.
  it("ignores expiry once the contract is submitted", () => {
    const contract = { status: "SUBMITTED", expiresAt: new Date("2026-08-01T12:00:00Z") };
    expect(deriveRowState({ conflicted: false, contract, now: NOW })).toBe("SUBMITTED");
  });
});

describe("isEligible", () => {
  it("allows send for states with no live submitted contract", () => {
    expect(isEligible("send", "NO_CONTRACT")).toBe(true);
    expect(isEligible("send", "SENT")).toBe(true);
    expect(isEligible("send", "EXPIRED")).toBe(true);
    expect(isEligible("send", "SUBMITTED")).toBe(false);
    expect(isEligible("send", "PROMOTED")).toBe(false);
    expect(isEligible("send", "CONFLICT")).toBe(false);
  });

  it("allows promote only for SUBMITTED", () => {
    expect(isEligible("promote", "SUBMITTED")).toBe(true);
    expect(isEligible("promote", "SENT")).toBe(false);
    expect(isEligible("promote", "NO_CONTRACT")).toBe(false);
    expect(isEligible("promote", "CONFLICT")).toBe(false);
  });

  it("allows withdraw wherever a non-promoted contract exists", () => {
    expect(isEligible("withdraw", "SENT")).toBe(true);
    expect(isEligible("withdraw", "EXPIRED")).toBe(true);
    expect(isEligible("withdraw", "SUBMITTED")).toBe(true);
    expect(isEligible("withdraw", "NO_CONTRACT")).toBe(false);
    expect(isEligible("withdraw", "PROMOTED")).toBe(false);
  });
});

describe("isSelectable", () => {
  it("excludes rows no action can touch", () => {
    expect(isSelectable("CONFLICT")).toBe(false);
    expect(isSelectable("PROMOTED")).toBe(false);
  });

  it("includes every row at least one action can touch", () => {
    for (const s of ["NO_CONTRACT", "SENT", "EXPIRED", "SUBMITTED"] as const) {
      expect(isSelectable(s)).toBe(true);
    }
  });
});

describe("filterRows", () => {
  const rows = [
    row({ acceptanceId: "a1", firstName: "Ona", lastName: "Boarder", departmentCode: "SRHD", state: "SUBMITTED" }),
    row({ acceptanceId: "a2", firstName: "Ray", lastName: "Chen", departmentCode: "PCAR", state: "EXPIRED" }),
    row({ acceptanceId: "a3", firstName: "Sam", lastName: "Ortiz", departmentCode: "SRHD", state: "CONFLICT" }),
  ];
  const all = { query: "", status: "ALL", dept: "ALL" } as const;

  it("returns everything by default", () => {
    expect(filterRows(rows, all)).toHaveLength(3);
  });

  it("filters by status", () => {
    expect(filterRows(rows, { ...all, status: "EXPIRED" }).map((r) => r.acceptanceId)).toEqual(["a2"]);
  });

  it("filters by department", () => {
    expect(filterRows(rows, { ...all, dept: "SRHD" }).map((r) => r.acceptanceId)).toEqual(["a1", "a3"]);
  });

  it("searches first and last name case-insensitively", () => {
    expect(filterRows(rows, { ...all, query: "chen" }).map((r) => r.acceptanceId)).toEqual(["a2"]);
    expect(filterRows(rows, { ...all, query: "ONA" }).map((r) => r.acceptanceId)).toEqual(["a1"]);
  });

  it("matches across the full name", () => {
    expect(filterRows(rows, { ...all, query: "ray c" }).map((r) => r.acceptanceId)).toEqual(["a2"]);
  });

  it("combines filters", () => {
    expect(filterRows(rows, { query: "", status: "SUBMITTED", dept: "PCAR" })).toEqual([]);
  });
});

describe("countEligible", () => {
  it("counts only rows the action can act on", () => {
    const rows = [
      row({ state: "SUBMITTED" }), row({ state: "SUBMITTED" }),
      row({ state: "EXPIRED" }), row({ state: "CONFLICT" }),
    ];
    expect(countEligible(rows, "promote")).toBe(2);
    expect(countEligible(rows, "send")).toBe(1);
    expect(countEligible(rows, "withdraw")).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_bulkactions' BLOB_READ_WRITE_TOKEN='' npx vitest run src/modules/recruitment/engine/onboarding-rows.test.ts`
Expected: FAIL, cannot resolve `./onboarding-rows`.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Pure row model for the recruitment onboarding table.
 *
 * Every function here is deterministic and takes `now` explicitly, so row state
 * (including link expiry) is resolved once on the server and never recomputed
 * during client render.
 */

export type OnboardingRowState =
  | "NO_CONTRACT"
  | "SENT"
  | "EXPIRED"
  | "SUBMITTED"
  | "PROMOTED"
  | "CONFLICT";

export type OnboardingBulkAction = "send" | "promote" | "withdraw";

export type OnboardingRow = {
  acceptanceId: string;
  contractId: string | null;
  firstName: string;
  lastName: string;
  departmentCode: string;
  state: OnboardingRowState;
  onRoster: boolean;
  customAnswers: { label: string; value: string }[];
};

export type OnboardingFilters = {
  query: string;
  status: OnboardingRowState | "ALL";
  dept: string | "ALL";
};

/**
 * Resolve the single state a row is in.
 *
 * CONFLICT wins over every contract state: an application accepted by more than
 * one department cannot be onboarded or promoted until SRR resolves it on the
 * Decisions page, no matter how far its contract got.
 *
 * Expiry only distinguishes SENT from EXPIRED, because it only gates the window
 * in which an applicant may still submit. A null expiresAt is grandfathered as
 * non-expiring (contracts predate the column).
 */
export function deriveRowState(input: {
  conflicted: boolean;
  contract: { status: string; expiresAt: Date | null } | null;
  now: Date;
}): OnboardingRowState {
  if (input.conflicted) return "CONFLICT";
  const c = input.contract;
  if (!c) return "NO_CONTRACT";
  if (c.status === "PROMOTED") return "PROMOTED";
  if (c.status === "SUBMITTED") return "SUBMITTED";
  const expired = c.expiresAt != null && c.expiresAt.getTime() < input.now.getTime();
  return expired ? "EXPIRED" : "SENT";
}

const ELIGIBLE_STATES: Record<OnboardingBulkAction, readonly OnboardingRowState[]> = {
  // createOrResendContract refuses any contract that is not PENDING.
  send: ["NO_CONTRACT", "SENT", "EXPIRED"],
  promote: ["SUBMITTED"],
  // withdrawContract refuses PROMOTED (that reversal is offboarding).
  withdraw: ["SENT", "EXPIRED", "SUBMITTED"],
};

export function isEligible(action: OnboardingBulkAction, state: OnboardingRowState): boolean {
  return ELIGIBLE_STATES[action].includes(state);
}

/** A row is selectable when at least one bulk action could act on it. Rows that
 *  fail this render no checkbox, so select-all never picks up dead weight. */
export function isSelectable(state: OnboardingRowState): boolean {
  return (["send", "promote", "withdraw"] as const).some((a) => isEligible(a, state));
}

export function filterRows(rows: OnboardingRow[], filters: OnboardingFilters): OnboardingRow[] {
  const q = filters.query.trim().toLowerCase();
  return rows.filter((r) => {
    if (filters.status !== "ALL" && r.state !== filters.status) return false;
    if (filters.dept !== "ALL" && r.departmentCode !== filters.dept) return false;
    if (q === "") return true;
    return `${r.firstName} ${r.lastName}`.toLowerCase().includes(q);
  });
}

export function countEligible(rows: OnboardingRow[], action: OnboardingBulkAction): number {
  return rows.reduce((n, r) => (isEligible(action, r.state) ? n + 1 : n), 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_bulkactions' BLOB_READ_WRITE_TOKEN='' npx vitest run src/modules/recruitment/engine/onboarding-rows.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/engine/onboarding-rows.ts src/modules/recruitment/engine/onboarding-rows.test.ts
git commit -m "feat(recruitment): add pure onboarding row state and eligibility model"
```

---

### Task 3: Narrow row projection in the service

`listOnboarding` returns `contract: true`, the whole row, including the onboarding `token` (a standing credential), `dateOfBirth`, `phone`, signature records, and HIPAA file metadata. That is safe only while the page is a server component. This task adds a projection that crosses to the client safely.

**Files:**
- Create: `src/modules/recruitment/test/seed-cycle.ts`
- Modify: `src/modules/recruitment/services/onboarding.ts`
- Test: `src/modules/recruitment/services/onboarding.rows.test.ts` (create)

**Interfaces:**
- Consumes: `deriveRowState`, `OnboardingRow` (Task 2); `resolveCustomAnswers` (Task 1); existing `listOnboarding`.
- Produces:
  - `listOnboardingRows(cycleId: string, now?: Date): Promise<OnboardingRow[]>`
  - `seedCycle(entries)` from `@/modules/recruitment/test/seed-cycle`, used by Tasks 4 and 7.

- [ ] **Step 1: Create the shared seeding module**

Create `src/modules/recruitment/test/seed-cycle.ts` with exactly the content given in **Shared test seeding** above.

- [ ] **Step 2: Write the failing test**

Open the test file with the reset hooks and import shown in **Shared test seeding**, then:

```ts
import { describe, it, expect } from "vitest";
import { listOnboardingRows } from "./onboarding";

describe("listOnboardingRows", () => {
  // The table is a client component, so everything returned here is serialized
  // into the RSC payload. The contract row carries a standing-credential token.
  it("never exposes the onboarding token", async () => {
    const { cycleId, acceptances } = await seedCycle([{ contract: { status: "PENDING" } }]);
    const rows = await listOnboardingRows(cycleId);
    expect(JSON.stringify(rows)).not.toContain("tok-");
    expect(rows[0]).toEqual({
      acceptanceId: acceptances[0].id,
      contractId: acceptances[0].contractId,
      firstName: "First0",
      lastName: "Last0",
      departmentCode: "SRHD",
      state: "SENT",
      onRoster: false,
      customAnswers: [],
    });
  });

  it("marks a lapsed pending contract EXPIRED", async () => {
    const { cycleId } = await seedCycle([
      { contract: { status: "PENDING", expiresAt: new Date("2026-01-01T00:00:00Z") } },
    ]);
    const rows = await listOnboardingRows(cycleId, new Date("2026-08-07T12:00:00Z"));
    expect(rows[0].state).toBe("EXPIRED");
  });

  it("marks a still-live pending contract SENT", async () => {
    const { cycleId } = await seedCycle([
      { contract: { status: "PENDING", expiresAt: new Date("2026-12-01T00:00:00Z") } },
    ]);
    const rows = await listOnboardingRows(cycleId, new Date("2026-08-07T12:00:00Z"));
    expect(rows[0].state).toBe("SENT");
  });

  it("marks an acceptance with no contract NO_CONTRACT", async () => {
    const { cycleId } = await seedCycle([{}]);
    const rows = await listOnboardingRows(cycleId);
    expect(rows[0].state).toBe("NO_CONTRACT");
    expect(rows[0].contractId).toBeNull();
  });

  // Two acceptances on ONE application means two departments accepted the same
  // person. Both rows must read CONFLICT regardless of contract state.
  it("marks an application accepted by two departments CONFLICT", async () => {
    const { cycleId } = await seedCycle([
      { applicationKey: "shared", dept: "SRHD", contract: { status: "SUBMITTED" } },
      { applicationKey: "shared", dept: "PCAR" },
    ]);
    const rows = await listOnboardingRows(cycleId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === "CONFLICT")).toBe(true);
  });

  it("sets onRoster once a contract has been promoted", async () => {
    const { cycleId, srrId } = await seedCycle([
      { contract: { status: "PROMOTED", promotedPersonId: null } },
    ]);
    await prisma.onboardingContract.updateMany({ data: { promotedPersonId: srrId } });
    const rows = await listOnboardingRows(cycleId);
    expect(rows[0].state).toBe("PROMOTED");
    expect(rows[0].onRoster).toBe(true);
  });

  it("resolves custom answers from the contract snapshot", async () => {
    const { cycleId } = await seedCycle([{
      contract: {
        status: "SUBMITTED",
        // custom_question requires `type` (a FieldType) and `required`; the
        // layout schema rejects the block without them.
        templateSnapshot: {
          blocks: [{
            kind: "custom_question", key: "tshirt", label: "T-shirt size",
            type: "SHORT_TEXT", required: false,
          }],
        },
        customAnswers: { tshirt: "M", confirm__strikes: "on" },
      },
    }]);
    const rows = await listOnboardingRows(cycleId);
    expect(rows[0].customAnswers).toEqual([{ label: "T-shirt size", value: "M" }]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_bulkactions' BLOB_READ_WRITE_TOKEN='' npx vitest run src/modules/recruitment/services/onboarding.rows.test.ts`
Expected: FAIL, `listOnboardingRows` is not exported.

- [ ] **Step 4: Write minimal implementation**

Append to `src/modules/recruitment/services/onboarding.ts`:

```ts
/**
 * Project this cycle's acceptances into the narrow row DTO the onboarding table
 * renders.
 *
 * listOnboarding returns whole OnboardingContract rows, which carry the link
 * token (a standing credential), date of birth, phone, signature records, and
 * HIPAA file metadata. The table is a client component, so anything returned
 * here is serialized into the RSC payload and shipped to the browser. Only the
 * fields below cross that boundary.
 *
 * `now` is a parameter so expiry is resolved once, here, rather than during
 * client render.
 */
export async function listOnboardingRows(
  cycleId: string,
  now: Date = new Date(),
): Promise<OnboardingRow[]> {
  const rows = await listOnboarding(cycleId);
  return rows.map((r) => ({
    acceptanceId: r.id,
    contractId: r.contract?.id ?? null,
    firstName: r.application.applicant.firstName,
    lastName: r.application.applicant.lastName,
    departmentCode: r.departmentCode,
    state: deriveRowState({ conflicted: r.conflicted, contract: r.contract, now }),
    onRoster: r.contract?.promotedPersonId != null,
    customAnswers: r.contract
      ? resolveCustomAnswers(r.contract.templateSnapshot, r.contract.customAnswers)
      : [],
  }));
}
```

Add the imports at the top of the file:

```ts
import { deriveRowState, type OnboardingRow } from "../engine/onboarding-rows";
import { resolveCustomAnswers } from "../contract/custom-answers";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_bulkactions' BLOB_READ_WRITE_TOKEN='' npx vitest run src/modules/recruitment/services/onboarding.rows.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/recruitment/test/seed-cycle.ts src/modules/recruitment/services/onboarding.ts src/modules/recruitment/services/onboarding.rows.test.ts
git commit -m "feat(recruitment): project onboarding rows without token or applicant PII"
```

---

### Task 4: Bulk withdraw service

Mirrors `promoteContracts`: one call, a batch of ids, a count summary. Keeps the loop and its error handling out of the server action.

**Files:**
- Modify: `src/modules/recruitment/services/onboarding.ts`
- Test: `src/modules/recruitment/services/onboarding.withdraw-bulk.test.ts` (create)

**Interfaces:**
- Consumes: existing `withdrawContract(contractId, actorId)`, `ContractError`, `RecruitmentAuthError`.
- Produces: `withdrawContracts(contractIds: string[], actorId: string): Promise<{ withdrawn: number; skipped: number; failed: number }>`

- [ ] **Step 1: Write the failing test**

Open with the reset hooks and `seedCycle` import shown in **Shared test seeding**
(Task 3 created that module), then:

```ts
import { describe, it, expect } from "vitest";
import { withdrawContracts } from "./onboarding";
import { RecruitmentAuthError } from "./review";

const twoPending = () => seedCycle([
  { contract: { status: "PENDING" } },
  { contract: { status: "PENDING" } },
]);

describe("withdrawContracts", () => {
  it("withdraws every eligible contract and reports the count", async () => {
    const { srrId, acceptances } = await twoPending();
    const ids = acceptances.map((a) => a.contractId!);
    const res = await withdrawContracts(ids, srrId);
    expect(res).toEqual({ withdrawn: 2, skipped: 0, failed: 0 });
    expect(await prisma.onboardingContract.count({ where: { id: { in: ids } } })).toBe(0);
  });

  // A promoted person is on the roster; the reversal is offboarding, not a
  // withdraw. It must not abort the rest of the batch.
  it("skips a promoted contract instead of failing the batch", async () => {
    const { srrId, acceptances } = await seedCycle([
      { contract: { status: "PENDING" } },
      { contract: { status: "PROMOTED" } },
    ]);
    const [pending, promoted] = acceptances;
    const res = await withdrawContracts([pending.contractId!, promoted.contractId!], srrId);
    expect(res).toEqual({ withdrawn: 1, skipped: 1, failed: 0 });
    expect(await prisma.onboardingContract.count({ where: { id: promoted.contractId! } })).toBe(1);
  });

  it("skips an id that does not exist", async () => {
    const { srrId } = await twoPending();
    const res = await withdrawContracts(["does-not-exist"], srrId);
    expect(res).toEqual({ withdrawn: 0, skipped: 1, failed: 0 });
  });

  it("returns a zero result for an empty batch", async () => {
    const { srrId } = await twoPending();
    expect(await withdrawContracts([], srrId)).toEqual({ withdrawn: 0, skipped: 0, failed: 0 });
  });

  // Authorization is checked once for the batch, not per contract, so a caller
  // without the permission gets a hard error rather than a silent zero-count.
  it("throws for an actor without recruitment.review_all", async () => {
    const { plainId, acceptances } = await twoPending();
    const ids = acceptances.map((a) => a.contractId!);
    await expect(withdrawContracts(ids, plainId)).rejects.toBeInstanceOf(RecruitmentAuthError);
    expect(await prisma.onboardingContract.count({ where: { id: { in: ids } } })).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_bulkactions' BLOB_READ_WRITE_TOKEN='' npx vitest run src/modules/recruitment/services/onboarding.withdraw-bulk.test.ts`
Expected: FAIL, `withdrawContracts` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/modules/recruitment/services/onboarding.ts`:

```ts
/**
 * Withdraw a batch of onboarding contracts.
 *
 * Authorization is checked once up front so a caller without the permission gets
 * a hard error rather than a silent all-skipped result. Past that, a contract
 * that is already promoted or already gone is a benign skip, not a failure: the
 * batch keeps going and the caller reports the split.
 *
 * Losing authorization mid-batch aborts. withdrawContract re-checks the
 * permission per contract, and `can` re-queries live state, so a role revoked
 * while this loop runs surfaces here. Absorbing that into the failure count
 * would keep hard-deleting under an actor whose authorization just changed.
 */
export async function withdrawContracts(
  contractIds: string[],
  actorId: string,
): Promise<{ withdrawn: number; skipped: number; failed: number }> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("Only SRR can withdraw onboarding contracts.");
  }
  let withdrawn = 0, skipped = 0, failed = 0;
  for (const id of contractIds) {
    try {
      await withdrawContract(id, actorId);
      withdrawn += 1;
    } catch (err) {
      if (err instanceof RecruitmentAuthError) throw err;
      if (err instanceof ContractError) { skipped += 1; continue; }
      failed += 1;
    }
  }
  return { withdrawn, skipped, failed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_bulkactions' BLOB_READ_WRITE_TOKEN='' npx vitest run src/modules/recruitment/services/onboarding.withdraw-bulk.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/onboarding.ts src/modules/recruitment/services/onboarding.withdraw-bulk.test.ts
git commit -m "feat(recruitment): add bulk withdrawContracts service"
```

---

### Task 5: Table component, rendering and filters

Builds the client component with its filter controls and row rendering. Selection comes in Task 6, so this task ends with a table that filters correctly and renders the right controls per row state.

**Files:**
- Create: `src/modules/recruitment/components/onboarding-table.tsx`
- Test: `src/modules/recruitment/components/onboarding-table.test.tsx`

**Interfaces:**
- Consumes: `OnboardingRow`, `OnboardingRowState`, `OnboardingFilters`, `filterRows`, `isSelectable`, `isEligible` (Task 2).
- Produces:
  ```ts
  export function OnboardingTable(props: {
    rows: OnboardingRow[];
    cycleId: string;
    sendLinks: (formData: FormData) => void | Promise<void>;
    promote: (formData: FormData) => void | Promise<void>;
    withdraw: (formData: FormData) => void | Promise<void>;
  }): React.JSX.Element
  ```
  Also exports `STATE_LABELS: Record<OnboardingRowState, { label: string; tone: "default" | "brand" | "success" | "warning" | "critical" }>`.

- [ ] **Step 1: Write the failing test**

Static-markup tests, matching the `renderToStaticMarkup` convention used across the repo (see `src/app/onboard/[token]/contract-field.test.tsx`).

```ts
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OnboardingTable } from "./onboarding-table";
import type { OnboardingRow } from "@/modules/recruitment/engine/onboarding-rows";

const noop = () => {};

function row(over: Partial<OnboardingRow> = {}): OnboardingRow {
  return {
    acceptanceId: "a1", contractId: "c1", firstName: "Ona", lastName: "Boarder",
    departmentCode: "SRHD", state: "SUBMITTED", onRoster: false, customAnswers: [],
    ...over,
  };
}

const html = (rows: OnboardingRow[]) =>
  renderToStaticMarkup(
    <OnboardingTable rows={rows} cycleId="cy1" sendLinks={noop} promote={noop} withdraw={noop} />,
  );

describe("OnboardingTable", () => {
  it("renders a checkbox for a selectable row", () => {
    expect(html([row({ state: "SUBMITTED" })])).toContain('name="acceptanceId"');
  });

  it("renders no checkbox for a conflicted row", () => {
    const out = html([row({ state: "CONFLICT" })]);
    expect(out).not.toContain('name="acceptanceId"');
    expect(out).toContain("Conflict");
  });

  it("renders no checkbox for a promoted row", () => {
    expect(html([row({ state: "PROMOTED" })])).not.toContain('name="acceptanceId"');
  });

  it("labels an expired link distinctly from a live one", () => {
    expect(html([row({ state: "EXPIRED" })])).toContain("Expired");
    expect(html([row({ state: "SENT" })])).toContain("Sent");
  });

  it("links to the contract review for a submitted row", () => {
    expect(html([row({ state: "SUBMITTED", contractId: "c9" })]))
      .toContain("/recruitment/cycles/cy1/onboarding/c9");
  });

  it("shows an on-roster marker once promoted", () => {
    expect(html([row({ state: "PROMOTED", onRoster: true })])).toContain("on roster");
  });

  it("renders resolved custom answers", () => {
    const out = html([row({ customAnswers: [{ label: "T-shirt size", value: "M" }] })]);
    expect(out).toContain("T-shirt size");
    expect(out).toContain("M");
  });

  it("offers only departments present in the rows", () => {
    const out = html([row({ departmentCode: "SRHD" }), row({ acceptanceId: "a2", departmentCode: "PCAR" })]);
    expect(out).toContain('value="SRHD"');
    expect(out).toContain('value="PCAR"');
    expect(out).not.toContain('value="BVHD"');
  });

  it("renders an empty state when there are no acceptances", () => {
    expect(html([])).toContain("No accepted applicants yet.");
  });

  // The per-row Withdraw is how you deal with one person without touching the
  // selection. It carries its own id so it cannot act on whatever is checked.
  it("renders a per-row withdraw carrying only that row's id", () => {
    const out = html([row({ state: "SUBMITTED", acceptanceId: "a7" })]);
    expect(out).toContain('name="onlyAcceptanceId"');
    expect(out).toContain('value="a7"');
  });

  it("renders no per-row withdraw for a row with no contract", () => {
    expect(html([row({ state: "NO_CONTRACT", contractId: null })])).not.toContain('name="onlyAcceptanceId"');
  });

  it("renders no per-row withdraw for a promoted row", () => {
    expect(html([row({ state: "PROMOTED" })])).not.toContain('name="onlyAcceptanceId"');
  });

  // Nothing is selected on first render, so the bulk actions all start at zero.
  it("starts every bulk action at a zero count", () => {
    const out = html([row({ state: "SUBMITTED" })]);
    expect(out).toContain("Send links (0)");
    expect(out).toContain("Promote (0)");
    expect(out).toContain("Withdraw (0)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_bulkactions' BLOB_READ_WRITE_TOKEN='' npx vitest run src/modules/recruitment/components/onboarding-table.test.tsx`
Expected: FAIL, cannot resolve `./onboarding-table`.

- [ ] **Step 3: Write minimal implementation**

```tsx
"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Checkbox } from "@/platform/ui/checkbox";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import {
  filterRows, isEligible, isSelectable,
  type OnboardingFilters, type OnboardingRow, type OnboardingRowState,
} from "@/modules/recruitment/engine/onboarding-rows";

type Tone = "default" | "brand" | "success" | "warning" | "critical";

export const STATE_LABELS: Record<OnboardingRowState, { label: string; tone: Tone }> = {
  NO_CONTRACT: { label: "No contract", tone: "default" },
  SENT: { label: "Sent", tone: "brand" },
  EXPIRED: { label: "Expired", tone: "critical" },
  SUBMITTED: { label: "Submitted", tone: "warning" },
  PROMOTED: { label: "Promoted", tone: "success" },
  CONFLICT: { label: "Conflict", tone: "warning" },
};

const STATUS_ORDER: OnboardingRowState[] = [
  "NO_CONTRACT", "SENT", "EXPIRED", "SUBMITTED", "PROMOTED", "CONFLICT",
];

export function OnboardingTable({
  rows, cycleId, sendLinks, promote, withdraw,
}: {
  rows: OnboardingRow[];
  cycleId: string;
  sendLinks: (formData: FormData) => void | Promise<void>;
  promote: (formData: FormData) => void | Promise<void>;
  withdraw: (formData: FormData) => void | Promise<void>;
}) {
  const [filters, setFilters] = useState<OnboardingFilters>({
    query: "", status: "ALL", dept: "ALL",
  });

  const departments = useMemo(
    () => [...new Set(rows.map((r) => r.departmentCode))].sort(),
    [rows],
  );
  const visible = useMemo(() => filterRows(rows, filters), [rows, filters]);

  return (
    <form className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-56">
          <Input
            type="search"
            placeholder="Search name…"
            aria-label="Search applicants by name"
            value={filters.query}
            onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
          />
        </div>
        <div className="w-44">
          <Select
            aria-label="Filter by status"
            value={filters.status}
            onChange={(e) =>
              setFilters((f) => ({ ...f, status: e.target.value as OnboardingFilters["status"] }))
            }
          >
            <option value="ALL">All statuses</option>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>{STATE_LABELS[s].label}</option>
            ))}
          </Select>
        </div>
        <div className="w-40">
          <Select
            aria-label="Filter by department"
            value={filters.dept}
            onChange={(e) => setFilters((f) => ({ ...f, dept: e.target.value }))}
          >
            <option value="ALL">All departments</option>
            {departments.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </Select>
        </div>
      </div>

      <Table>
        <THead>
          <tr>
            <TH className="w-10"><span className="sr-only">Select</span></TH>
            <TH>Applicant</TH>
            <TH>Dept</TH>
            <TH>Status</TH>
          </tr>
        </THead>
        <tbody>
          {visible.map((r) => {
            const s = STATE_LABELS[r.state];
            return (
              <TR key={r.acceptanceId}>
                <TD>
                  {isSelectable(r.state) && (
                    <Checkbox
                      name="acceptanceId"
                      value={r.acceptanceId}
                      aria-label={`Select ${r.firstName} ${r.lastName}`}
                    />
                  )}
                </TD>
                <TD className="font-medium text-foreground">
                  {r.firstName} {r.lastName}
                  {r.customAnswers.length > 0 && (
                    <dl className="mt-1 space-y-0.5 text-xs font-normal text-subtle-foreground">
                      {r.customAnswers.map((a) => (
                        <div key={a.label}>
                          <span className="font-medium">{a.label}:</span> {a.value}
                        </div>
                      ))}
                    </dl>
                  )}
                </TD>
                <TD className="text-foreground-soft">{r.departmentCode}</TD>
                <TD>
                  <Badge tone={s.tone}>{s.label}</Badge>
                  {r.onRoster && <span className="ml-2 text-xs text-subtle-foreground">on roster</span>}
                  {r.contractId && (r.state === "SUBMITTED" || r.state === "PROMOTED") && (
                    <Link
                      className="ml-2 text-xs text-brand-fg hover:text-brand-hover"
                      href={`/recruitment/cycles/${cycleId}/onboarding/${r.contractId}`}
                    >
                      View
                    </Link>
                  )}
                  {/* Per-row withdraw, for dealing with one person without
                      disturbing the selection. It submits its own id under a
                      distinct name, so withdrawAction acts on this row alone
                      even when other rows are checked. */}
                  {isEligible("withdraw", r.state) && (
                    <ConfirmButton
                      label="Withdraw"
                      size="sm"
                      className="ml-2 inline-flex align-middle"
                      formAction={withdraw}
                      name="onlyAcceptanceId"
                      value={r.acceptanceId}
                      confirmLabel={`Withdraw${r.state === "SUBMITTED" ? " (deletes the submitted contract + signatures)" : ""}?`}
                    />
                  )}
                </TD>
              </TR>
            );
          })}
          {visible.length === 0 && (
            <TR>
              <TD colSpan={4} className="py-10 text-center text-subtle-foreground">
                {rows.length === 0 ? "No accepted applicants yet." : "No applicants match these filters."}
              </TD>
            </TR>
          )}
        </tbody>
      </Table>

      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton size="sm" formAction={sendLinks} pendingLabel="Sending…" disabled>
          Send links (0)
        </SubmitButton>
        <SubmitButton size="sm" formAction={promote} pendingLabel="Promoting…" disabled>
          Promote (0)
        </SubmitButton>
        <ConfirmButton
          label="Withdraw (0)"
          size="sm"
          formAction={withdraw}
          confirmLabel="Withdraw?"
          disabled
        />
      </div>
    </form>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_bulkactions' BLOB_READ_WRITE_TOKEN='' npx vitest run src/modules/recruitment/components/onboarding-table.test.tsx`
Expected: PASS.

`Badge`'s tones are exactly `default | brand | success | warning | critical`, so the `Tone` type above matches the primitive. Do not add a new tone.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/components/onboarding-table.tsx src/modules/recruitment/components/onboarding-table.test.tsx
git commit -m "feat(recruitment): add filterable onboarding table component"
```

---

### Task 6: Selection and the action bar

Adds selection state on top of Task 5: per-row checkboxes become controlled, select-all drives the visible selectable set, filtering prunes the selection, and each action button shows its own eligible count.

**Files:**
- Modify: `src/modules/recruitment/components/onboarding-table.tsx`
- Test: `src/modules/recruitment/components/onboarding-table.interaction.test.tsx` (create)

**Interfaces:**
- Consumes: everything from Task 5, plus `countEligible` (Task 2). `isEligible` is already imported by Task 5.
- Produces: no new exports. `OnboardingTable`'s props are unchanged.

- [ ] **Step 1: Write the failing test**

Interaction tests need a real DOM. Follow the established per-file opt-in pattern in `src/platform/ui/combobox.test.tsx`: `// @vitest-environment jsdom`, `createRoot`, and `act` from React. Do not add `@testing-library/react`.

```tsx
// @vitest-environment jsdom
/**
 * Interaction tests for OnboardingTable's selection model. Static markup is
 * covered in onboarding-table.test.tsx; these cover the parts that only exist
 * in a live DOM: the indeterminate header property, shift-click ranges, and
 * selection pruning when a filter changes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OnboardingTable } from "./onboarding-table";
import type { OnboardingRow } from "@/modules/recruitment/engine/onboarding-rows";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};
let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount(rows: OnboardingRow[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <OnboardingTable rows={rows} cycleId="cy1" sendLinks={noop} promote={noop} withdraw={noop} />,
    );
  });
  mounted = { container, root };
  return container;
}

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
});

function row(over: Partial<OnboardingRow> = {}): OnboardingRow {
  return {
    acceptanceId: "a1", contractId: "c1", firstName: "Ona", lastName: "Boarder",
    departmentCode: "SRHD", state: "SUBMITTED", onRoster: false, customAnswers: [],
    ...over,
  };
}

const rowBoxes = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLInputElement>('input[name="acceptanceId"]')];
const headerBox = (c: HTMLElement) =>
  c.querySelector<HTMLInputElement>('input[aria-label="Select all"]')!;
/**
 * Find an action-bar button by its label.
 *
 * Matches on the "(N)" count suffix deliberately: the per-row Withdraw buttons
 * render BEFORE the action bar and their text also starts with "Withdraw", so a
 * bare startsWith would return a row button instead of the bulk one.
 */
const button = (c: HTMLElement, label: string) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent?.startsWith(`${label} (`))!;
const click = (el: HTMLElement, init: MouseEventInit = {}) =>
  act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init })); });

const THREE = [
  row({ acceptanceId: "a1", state: "SUBMITTED", departmentCode: "SRHD" }),
  row({ acceptanceId: "a2", state: "EXPIRED", departmentCode: "PCAR" }),
  row({ acceptanceId: "a3", state: "NO_CONTRACT", departmentCode: "SRHD" }),
];

describe("OnboardingTable selection", () => {
  it("selects every visible selectable row from the header checkbox", () => {
    const c = mount(THREE);
    click(headerBox(c));
    expect(rowBoxes(c).every((b) => b.checked)).toBe(true);
  });

  it("puts the header checkbox in the indeterminate state on a partial selection", () => {
    const c = mount(THREE);
    click(rowBoxes(c)[0]);
    expect(headerBox(c).indeterminate).toBe(true);
    expect(headerBox(c).checked).toBe(false);
  });

  it("clears the indeterminate state once everything is selected", () => {
    const c = mount(THREE);
    click(headerBox(c));
    expect(headerBox(c).indeterminate).toBe(false);
    expect(headerBox(c).checked).toBe(true);
  });

  it("selects a range on shift-click", () => {
    const c = mount(THREE);
    click(rowBoxes(c)[0]);
    click(rowBoxes(c)[2], { shiftKey: true });
    expect(rowBoxes(c).map((b) => b.checked)).toEqual([true, true, true]);
  });

  it("counts eligibility per action", () => {
    const c = mount(THREE);
    click(headerBox(c));
    // a1 SUBMITTED, a2 EXPIRED, a3 NO_CONTRACT
    expect(button(c, "Send links").textContent).toContain("(2)");
    expect(button(c, "Promote").textContent).toContain("(1)");
    expect(button(c, "Withdraw").textContent).toContain("(2)");
  });

  it("disables an action with no eligible row in the selection", () => {
    const c = mount([row({ acceptanceId: "a1", state: "NO_CONTRACT" })]);
    click(rowBoxes(c)[0]);
    expect(button(c, "Promote").hasAttribute("disabled")).toBe(true);
    expect(button(c, "Send links").hasAttribute("disabled")).toBe(false);
  });

  // A hidden selection would let Withdraw destroy contracts the operator cannot
  // see at the moment they confirm.
  it("prunes the selection to visible rows when a filter changes", () => {
    const c = mount(THREE);
    click(headerBox(c));
    const dept = c.querySelector<HTMLSelectElement>('select[aria-label="Filter by department"]')!;
    act(() => {
      dept.value = "PCAR";
      dept.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(rowBoxes(c)).toHaveLength(1);
    expect(button(c, "Withdraw").textContent).toContain("(1)");
  });

  it("reports the selected count and clears it", () => {
    const c = mount(THREE);
    click(headerBox(c));
    expect(c.textContent).toContain("3 selected");
    const clear = [...c.querySelectorAll("button")].find((b) => b.textContent === "Clear")!;
    click(clear);
    expect(rowBoxes(c).some((b) => b.checked)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_bulkactions' BLOB_READ_WRITE_TOKEN='' npx vitest run src/modules/recruitment/components/onboarding-table.interaction.test.tsx`
Expected: FAIL, there is no header checkbox and the buttons have static counts.

- [ ] **Step 3: Write minimal implementation**

Modify `onboarding-table.tsx`. Add to the imports:

```tsx
import { useEffect, useRef } from "react";
import { Button } from "@/platform/ui/button";
import { countEligible } from "@/modules/recruitment/engine/onboarding-rows";
```

Add selection state next to `filters`:

```tsx
const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
// Anchor for shift-click ranges, in visible order.
const anchorRef = useRef<string | null>(null);
const headerRef = useRef<HTMLInputElement>(null);
```

After `visible` is computed, add the derived values. Pruning happens during render rather than in an effect, so the selection and the rendered checkboxes can never disagree even for one frame:

```tsx
const selectableVisible = useMemo(() => visible.filter((r) => isSelectable(r.state)), [visible]);

// The selection is always scoped to what is on screen. Filtering something out
// deselects it, so a bulk action can never touch a row the operator cannot see.
const effectiveSelected = useMemo(() => {
  const visibleIds = new Set(selectableVisible.map((r) => r.acceptanceId));
  return new Set([...selected].filter((id) => visibleIds.has(id)));
}, [selected, selectableVisible]);

const selectedRows = useMemo(
  () => selectableVisible.filter((r) => effectiveSelected.has(r.acceptanceId)),
  [selectableVisible, effectiveSelected],
);

const counts = {
  send: countEligible(selectedRows, "send"),
  promote: countEligible(selectedRows, "promote"),
  withdraw: countEligible(selectedRows, "withdraw"),
};
const submittedInSelection = selectedRows.filter((r) => r.state === "SUBMITTED").length;
const allVisibleSelected =
  selectableVisible.length > 0 && effectiveSelected.size === selectableVisible.length;

useEffect(() => {
  if (headerRef.current) {
    headerRef.current.indeterminate =
      effectiveSelected.size > 0 && !allVisibleSelected;
  }
}, [effectiveSelected, allVisibleSelected]);
```

Add the selection handlers:

```tsx
function toggleAll() {
  setSelected(allVisibleSelected ? new Set() : new Set(selectableVisible.map((r) => r.acceptanceId)));
  anchorRef.current = null;
}

function toggleRow(acceptanceId: string, shiftKey: boolean) {
  setSelected((prev) => {
    const next = new Set(prev);
    const anchor = anchorRef.current;
    // Shift-click extends from the anchor across the visible order, selecting
    // the whole span rather than toggling each member.
    if (shiftKey && anchor !== null) {
      const ids = selectableVisible.map((r) => r.acceptanceId);
      const from = ids.indexOf(anchor);
      const to = ids.indexOf(acceptanceId);
      if (from !== -1 && to !== -1) {
        for (const id of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(id);
        return next;
      }
    }
    if (next.has(acceptanceId)) next.delete(acceptanceId);
    else next.add(acceptanceId);
    return next;
  });
  anchorRef.current = acceptanceId;
}
```

Add the header checkbox as the first `<TH>`'s content, replacing the `sr-only` span:

```tsx
<TH className="w-10">
  <Checkbox
    ref={headerRef}
    aria-label="Select all"
    checked={allVisibleSelected}
    onChange={toggleAll}
    disabled={selectableVisible.length === 0}
  />
</TH>
```

Make each row checkbox controlled. `onClick` carries `shiftKey` (a `change` event does not), and `onChange` is present so React does not warn about a controlled input without a handler:

```tsx
<Checkbox
  name="acceptanceId"
  value={r.acceptanceId}
  aria-label={`Select ${r.firstName} ${r.lastName}`}
  checked={effectiveSelected.has(r.acceptanceId)}
  onClick={(e) => toggleRow(r.acceptanceId, e.shiftKey)}
  onChange={() => {}}
/>
```

Replace the action bar with the live version:

```tsx
<div className="flex flex-wrap items-center gap-2">
  <SubmitButton size="sm" formAction={sendLinks} pendingLabel="Sending…" disabled={counts.send === 0}>
    Send links ({counts.send})
  </SubmitButton>
  <SubmitButton size="sm" formAction={promote} pendingLabel="Promoting…" disabled={counts.promote === 0}>
    Promote ({counts.promote})
  </SubmitButton>
  {/* No formAction: this rides the form's default action (withdraw). See the
      submit-button constraint in Global Constraints. */}
  <ConfirmButton
    label={`Withdraw (${counts.withdraw})`}
    size="sm"
    disabled={counts.withdraw === 0}
    confirmLabel={
      submittedInSelection > 0
        ? `Withdraw ${counts.withdraw}? Deletes ${submittedInSelection} submitted contract(s) + signatures`
        : `Withdraw ${counts.withdraw}?`
    }
  />
  {effectiveSelected.size > 0 && (
    <span className="text-xs text-subtle-foreground">
      {effectiveSelected.size} selected
    </span>
  )}
  {effectiveSelected.size > 0 && (
    <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
      Clear
    </Button>
  )}
</div>
```

- [ ] **Step 4: Run both component test files to verify they pass**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_bulkactions' BLOB_READ_WRITE_TOKEN='' npx vitest run src/modules/recruitment/components/`
Expected: PASS, both files.

`Button`'s variants are exactly `primary | outline | danger | ghost`, so `ghost` above is valid.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/components/onboarding-table.tsx src/modules/recruitment/components/onboarding-table.interaction.test.tsx
git commit -m "feat(recruitment): add bulk selection and action bar to onboarding table"
```

---

### Task 7: Server actions on a unified payload

All three actions take `acceptanceId[]`, re-derive eligibility from the database, and report acted / not-eligible / failed separately.

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/onboarding/actions.ts`
- Test: `src/app/(app)/recruitment/cycles/[id]/onboarding/actions.test.ts` (create)

**Interfaces:**
- Consumes: `withdrawContracts` (Task 4), existing `createOrResendContract`, `promoteContracts`, `ContractError`, `RecruitmentAuthError`.
- Produces: `sendLinksAction(cycleId, formData)`, `promoteAction(cycleId, formData)`, `withdrawAction(cycleId, formData)`, all `(cycleId: string, formData: FormData) => Promise<never>`. `withdrawContractAction` is removed; the per-row Withdraw submits a one-element selection to `withdrawAction`.

- [ ] **Step 1: Write the failing test**

The database stays real so the cycle scoping and eligibility queries are genuinely
exercised; only the session, telemetry, settings, and navigation are mocked. Add
the reset hooks and `seedCycle` import shown in **Shared test seeding** (Task 3
created that module) below the mock block.

```ts
import { describe, it, expect, vi } from "vitest";

// redirect() signals by throwing NEXT_REDIRECT; capture the target instead.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); },
}));
// Set per test, so one seeded actor can drive every action.
const session = { personId: "" };
vi.mock("@/platform/auth/session", () => ({
  requirePersonSession: async () => session,
}));
vi.mock("@/platform/posthog/capture", () => ({ captureEvent: vi.fn() }));
vi.mock("@/platform/posthog/groups", () => ({ termGroupForCycle: async () => ({ term: "t" }) }));
vi.mock("@/platform/settings/service", () => ({
  getSetting: async () => "https://hub.test",
}));

import { sendLinksAction, promoteAction, withdrawAction } from "./actions";

function form(ids: string[]) {
  const fd = new FormData();
  for (const id of ids) fd.append("acceptanceId", id);
  return fd;
}

/** Run an action and return the URL it redirected to. */
async function target(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const m = (e as Error).message;
    if (m.startsWith("REDIRECT:")) return decodeURIComponent(m.slice("REDIRECT:".length));
    throw e;
  }
  throw new Error("expected a redirect");
}

describe("onboarding bulk actions", () => {
  it("rejects an empty selection", async () => {
    const { cycleId, srrId } = await seedCycle([{}]);
    session.personId = srrId;
    const url = await target(() => sendLinksAction(cycleId, form([])));
    expect(url).toContain("err=");
    expect(url).toContain("Select at least one");
  });

  // Scoping is the guard against a forged id from another cycle.
  it("ignores an acceptance that belongs to another cycle", async () => {
    const a = await seedCycle([{}]);
    const b = await seedCycle([{}]);
    session.personId = a.srrId;
    const url = await target(() => sendLinksAction(a.cycleId, form([b.acceptances[0].id])));
    expect(url).toContain("Sent 0");
    expect(url).toContain("1 not eligible");
  });

  // Selecting an already-promoted row and hitting Send is routine once
  // select-all exists. It must read as informational, not as a red failure.
  it("reports an ineligible row as not eligible, not as a failure", async () => {
    const { cycleId, srrId, acceptances } = await seedCycle([
      {},
      { contract: { status: "PROMOTED" } },
    ]);
    session.personId = srrId;
    const url = await target(() =>
      sendLinksAction(cycleId, form([acceptances[0].id, acceptances[1].id])));
    expect(url).toContain("Sent 1");
    expect(url).toContain("1 not eligible");
    expect(url).not.toContain("err=");
  });

  it("promotes only the submitted rows in a mixed selection", async () => {
    const { cycleId, srrId, acceptances } = await seedCycle([
      { contract: { status: "SUBMITTED" } },
      { contract: { status: "PENDING" } },
    ]);
    session.personId = srrId;
    const url = await target(() =>
      promoteAction(cycleId, form([acceptances[0].id, acceptances[1].id])));
    expect(url).toContain("1 new");
    expect(url).toContain("1 not eligible");
  });

  it("withdraws a batch and reports the count", async () => {
    const { cycleId, srrId, acceptances } = await seedCycle([
      { contract: { status: "PENDING" } },
      { contract: { status: "PENDING" } },
    ]);
    session.personId = srrId;
    const url = await target(() =>
      withdrawAction(cycleId, form(acceptances.map((a) => a.id))));
    expect(url).toContain("Withdrew 2");
  });

  // The per-row Withdraw button rides in the same form as the checkboxes, so
  // its id must win outright or one row's button would withdraw the selection.
  it("acts on onlyAcceptanceId alone, ignoring checked rows", async () => {
    const { cycleId, srrId, acceptances } = await seedCycle([
      { contract: { status: "PENDING" } },
      { contract: { status: "PENDING" } },
    ]);
    session.personId = srrId;
    const fd = form(acceptances.map((a) => a.id));
    fd.set("onlyAcceptanceId", acceptances[0].id);
    const url = await target(() => withdrawAction(cycleId, fd));
    expect(url).toContain("Withdrew 1");
    expect(await prisma.onboardingContract.count()).toBe(1);
  });

  it("refuses an actor without recruitment.review_all", async () => {
    const { cycleId, plainId, acceptances } = await seedCycle([
      { contract: { status: "PENDING" } },
    ]);
    session.personId = plainId;
    const url = await target(() => withdrawAction(cycleId, form([acceptances[0].id])));
    expect(url).toContain("err=");
    expect(await prisma.onboardingContract.count()).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_bulkactions' BLOB_READ_WRITE_TOKEN='' npx vitest run "src/app/(app)/recruitment/cycles/[id]/onboarding/actions.test.ts"`
Expected: FAIL, `withdrawAction` is not exported.

- [ ] **Step 3: Write the implementation**

Rewrite `actions.ts`. Two structural rules to follow throughout: every `redirect()` call sits **outside** any `try` block (`redirect` signals by throwing, so a `catch` around it swallows the navigation), and every query is scoped to `cycleId`.

```ts
"use server";
import { redirect } from "next/navigation";
import { prisma } from "@/platform/db";
import { requirePersonSession } from "@/platform/auth/session";
import { captureEvent } from "@/platform/posthog/capture";
import { termGroupForCycle } from "@/platform/posthog/groups";
import { getSetting } from "@/platform/settings/service";
import { createOrResendContract, withdrawContracts, ContractError } from "@/modules/recruitment/services/onboarding";
import { promoteContracts } from "@/modules/recruitment/services/promotion";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";

function bounce(cycleId: string, params: { msg?: string; err?: string }) {
  const q = new URLSearchParams();
  if (params.msg) q.set("msg", params.msg);
  if (params.err) q.set("err", params.err);
  return `/recruitment/cycles/${cycleId}/onboarding?${q.toString()}`;
}

/** Append the informational tail shared by all three actions. A not-eligible row
 *  is an expected outcome of acting on a wide selection, so it rides along with
 *  the success message; only `failed` is an error. */
function summarize(base: string, notEligible: number): string {
  return notEligible > 0 ? `${base} ${notEligible} not eligible.` : base;
}

/** Load the selected acceptances that actually belong to this cycle, with just
 *  enough contract state to decide eligibility server-side. The client's counts
 *  are never trusted. */
async function scopedAcceptances(cycleId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return prisma.acceptance.findMany({
    where: { id: { in: ids }, application: { cycleId } },
    select: { id: true, contract: { select: { id: true, status: true } } },
  });
}

/**
 * The ids an action should act on.
 *
 * A per-row action button submits its own id under `onlyAcceptanceId` and wins
 * outright. Without this, clicking a row's Withdraw while other rows happen to
 * be checked would withdraw the whole selection, because a submit button's
 * name/value rides along with every checked box in the same form.
 */
function selectedIds(formData: FormData): string[] {
  const only = String(formData.get("onlyAcceptanceId") ?? "");
  if (only !== "") return [only];
  return [...new Set(formData.getAll("acceptanceId").map(String))].filter((id) => id !== "");
}

export async function sendLinksAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const ids = selectedIds(formData);
  if (ids.length === 0) redirect(bounce(cycleId, { err: "Select at least one applicant." }));

  const rows = await scopedAcceptances(cycleId, ids);
  // Eligible to send: no contract yet, or one still PENDING (createOrResendContract
  // refuses anything else). Ids not in `rows` were never in this cycle.
  const eligible = rows.filter((r) => r.contract == null || r.contract.status === "PENDING");
  const notEligible = ids.length - eligible.length;

  const base = await getSetting<string>("app.baseUrl");
  let sent = 0, failed = 0;
  for (const row of eligible) {
    try {
      await createOrResendContract(row.id, person.personId, base);
      sent += 1;
    } catch (err) {
      // A conflicted acceptance or a closed cycle lands here. It is a refusal,
      // not a crash, so it is reported rather than thrown.
      if (err instanceof RecruitmentAuthError || err instanceof ContractError) { failed += 1; continue; }
      throw err;
    }
  }

  if (sent > 0) {
    await captureEvent({
      distinctId: person.personId,
      event: "onboarding_links_sent",
      properties: { cycle_id: cycleId, sent, not_eligible: notEligible, failed },
      groups: await termGroupForCycle(cycleId),
    });
  }

  const msg = summarize(`Sent ${sent} onboarding link(s).`, notEligible);
  redirect(bounce(cycleId, failed > 0 ? { msg, err: `${failed} could not be sent.` } : { msg }));
}

export async function promoteAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const ids = selectedIds(formData);
  if (ids.length === 0) redirect(bounce(cycleId, { err: "Select at least one applicant." }));

  const rows = await scopedAcceptances(cycleId, ids);
  const contractIds = rows
    .filter((r) => r.contract?.status === "SUBMITTED")
    .map((r) => r.contract!.id);
  const notEligible = ids.length - contractIds.length;

  let res: Awaited<ReturnType<typeof promoteContracts>>;
  try {
    res = await promoteContracts(contractIds, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError) redirect(bounce(cycleId, { err: (err as Error).message }));
    throw err;
  }

  await captureEvent({
    distinctId: person.personId,
    event: "volunteers_promoted",
    properties: {
      cycle_id: cycleId, created: res.created, reactivated: res.reactivated,
      skipped: res.skipped, not_eligible: notEligible, failed: res.failed,
    },
    groups: await termGroupForCycle(cycleId),
  });

  // promoteContracts counts a conflicted or non-submitted contract as `skipped`.
  // Fold that into not-eligible: from the operator's side both mean "nothing
  // happened to that row, and nothing needed to".
  const msg = summarize(
    `Promoted: ${res.created} new, ${res.reactivated} returning.`,
    notEligible + res.skipped,
  );
  // A contract that errored out is NOT a benign skip: that person was never
  // created and holds no membership, so they are absent from every roster for
  // the term. Surface it so the SRR retries rather than reading a green banner.
  redirect(bounce(cycleId, res.failed > 0
    ? { msg, err: `${res.failed} failed to promote and must be retried.` }
    : { msg }));
}

export async function withdrawAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const ids = selectedIds(formData);
  if (ids.length === 0) redirect(bounce(cycleId, { err: "Select at least one applicant." }));

  const rows = await scopedAcceptances(cycleId, ids);
  const contractIds = rows
    .filter((r) => r.contract != null && r.contract.status !== "PROMOTED")
    .map((r) => r.contract!.id);
  const notEligible = ids.length - contractIds.length;

  let res: Awaited<ReturnType<typeof withdrawContracts>>;
  try {
    res = await withdrawContracts(contractIds, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError) redirect(bounce(cycleId, { err: (err as Error).message }));
    throw err;
  }

  const msg = summarize(
    `Withdrew ${res.withdrawn} onboarding contract(s). You can now change the decision or resend a fresh link.`,
    notEligible + res.skipped,
  );
  redirect(bounce(cycleId, res.failed > 0
    ? { msg, err: `${res.failed} could not be withdrawn.` }
    : { msg }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_bulkactions' BLOB_READ_WRITE_TOKEN='' npx vitest run "src/app/(app)/recruitment/cycles/[id]/onboarding/"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/onboarding/actions.ts" "src/app/(app)/recruitment/cycles/[id]/onboarding/actions.test.ts"
git commit -m "feat(recruitment): unify onboarding bulk actions on an acceptance payload"
```

---

### Task 8: Wire the page

Replaces the page's two forms with the single table and deletes the code the helpers replaced.

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/onboarding/page.tsx`

**Interfaces:**
- Consumes: `listOnboardingRows` (Task 3), `OnboardingTable` (Tasks 5 and 6), the three actions (Task 7).
- Produces: nothing further.

- [ ] **Step 1: Replace the page body**

The page keeps its permission checks, breadcrumb, and header, and drops `statusLabel`, the inline custom-answer IIFE, the `promotable` list, and both forms. The conflict hint stays, because it tells the operator where to go to fix a `CONFLICT` row.

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listOnboardingRows } from "@/modules/recruitment/services/onboarding";
import { sendLinksAction, promoteAction, withdrawAction } from "./actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { OnboardingTable } from "@/modules/recruitment/components/onboarding-table";

export default async function OnboardingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePermission("recruitment.access");
  await requirePermission("recruitment.review_all");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const rows = await listOnboardingRows(id);
  const hasConflicts = rows.some((r) => r.state === "CONFLICT");

  return (
    <div className="max-w-4xl space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Onboarding", slug: "onboarding" },
        })}
      />
      <PageHeader title="Onboarding" description={cycle.title} />

      <OnboardingTable
        rows={rows}
        cycleId={id}
        sendLinks={sendLinksAction.bind(null, id)}
        promote={promoteAction.bind(null, id)}
        withdraw={withdrawAction.bind(null, id)}
      />

      <p className="text-xs text-subtle-foreground">
        Resending refreshes the 21-day expiry on the same link, so an expired or
        undelivered link is recoverable without a fresh acceptance.
      </p>
      {hasConflicts && (
        <p className="text-xs text-subtle-foreground">
          Applicants accepted by more than one department are marked{" "}
          <span className="font-medium text-foreground-soft">Conflict</span> and can&apos;t be onboarded until you resolve
          them on the{" "}
          <Link className="text-brand-fg hover:text-brand-hover" href={`/recruitment/cycles/${id}/decisions`}>
            Decisions
          </Link>{" "}
          page.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify the whole recruitment suite still passes**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_bulkactions' BLOB_READ_WRITE_TOKEN='' npx vitest run src/modules/recruitment "src/app/(app)/recruitment"`
Expected: PASS. Read the summary counts; do not rely on the exit code if you pipe the output.

- [ ] **Step 3: Verify types and lint**

Run: `npx tsc --noEmit`
Expected: no errors outside `.next/` (filter with `grep -v '\.next/'`; a stale generated route module there is a known local artifact).

Run: `npx eslint src e2e`
Expected: clean. Use `npx eslint src e2e`, not `npm run lint`, which also walks the gitignored `HAVEN Free Clinic Design System/` folder.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/onboarding/page.tsx"
git commit -m "feat(recruitment): render the onboarding page as one bulk-action table"
```

---

### Task 9: End-to-end coverage

Updates the e2e spec for the new UI and fixes the selector stranded by commit `735be20e`.

**Files:**
- Modify: `e2e/recruitment-onboarding.spec.ts:99-106`

**Interfaces:**
- Consumes: the shipped UI from Tasks 5 through 8.
- Produces: nothing.

- [ ] **Step 1: Replace the onboarding assertions**

The existing block clicks `button:has-text("Send onboarding links")`, which has not matched since the button was renamed to "Send / resend onboarding links". Anchor on the accessible name with a `^` so the trailing count cannot break it again, and cover the bulk path the feature adds.

```ts
  // --- Onboarding page: send link, assert banner + row status ---
  await page.goto(`/recruitment/cycles/${cycleId}/onboarding`);

  // Nothing is selected on load, so every bulk action starts disabled.
  const sendLinks = page.getByRole("button", { name: /^Send links/ });
  await expect(sendLinks).toBeDisabled();

  // Select-all picks up the one selectable row and enables Send.
  await page.getByRole("checkbox", { name: "Select all" }).check();
  await expect(page.getByText("1 selected")).toBeVisible();
  await expect(sendLinks).toHaveText(/Send links \(1\)/);
  await sendLinks.click();

  await expect(page.getByText(/Sent 1 onboarding link\(s\)\./)).toBeVisible();
  // Anchor the status badge exactly: "Sent" is a substring of other copy on the page.
  await expect(page.getByRole("cell").filter({ hasText: /^Sent$/ })).toBeVisible();

  // The row is now PENDING, so Promote has nothing eligible but Withdraw does.
  await page.getByRole("checkbox", { name: /^Select Ona Boarder$/ }).check();
  await expect(page.getByRole("button", { name: /^Promote \(0\)/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Withdraw \(1\)/ })).toBeEnabled();

  // Status filter narrows the table and prunes the selection with it.
  await page.getByLabel("Filter by status").selectOption("SUBMITTED");
  await expect(page.getByText("No applicants match these filters.")).toBeVisible();
  await expect(page.getByText("1 selected")).toHaveCount(0);
```

- [ ] **Step 2: Run the spec**

Read `docs/` or the memory note on running e2e locally for the exact environment first; e2e needs a running app and its own database, and the repo `.env` points at production Neon.

Run: `npx playwright test e2e/recruitment-onboarding.spec.ts`
Expected: PASS.

If the local e2e environment is not available, say so explicitly rather than reporting the step as done, and let CI run it.

- [ ] **Step 3: Commit**

```bash
git add e2e/recruitment-onboarding.spec.ts
git commit -m "test(e2e): cover onboarding bulk selection and fix a stranded selector"
```

---

## Final verification

- [ ] Full suite: `TEST_DATABASE_URL='postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_bulkactions' BLOB_READ_WRITE_TOKEN='' npx vitest run`. Compare the pass/fail counts against the baseline recorded before Task 1; the only acceptable failures are ones that also failed at baseline.
- [ ] `npx eslint src e2e` clean.
- [ ] `npx tsc --noEmit` clean outside `.next/`.
- [ ] Grep the diff for U+2014: `git diff origin/main -- 'src/*' | grep -n '—'` returns nothing.
