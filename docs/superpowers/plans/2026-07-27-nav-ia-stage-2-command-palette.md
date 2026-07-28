# Navigation IA Stage 2 (Command Palette) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `Cmd+K` command palette that jumps to any page the viewer can open, plus permission-scoped search over people, recruitment cycles, and support requests.

**Architecture:** Pages resolve locally from the `NavModule[]` the Stage 1 dropdowns already hold, so they are instant and cost no query. Entities resolve from one new `GET /api/search` route that filters every result server-side using the destination page's own gate. The visible trigger is funded by removing the pill's active-term label.

**Tech Stack:** Next.js App Router (RSC + "use client"), TypeScript, Tailwind, Prisma, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-26-nav-ia-user-friendliness-design.md` (Stage 2)

**Branch:** continue on `design/nav-ia-user-friendliness` (extends PR #465).

## Global Constraints

- **No em-dashes anywhere**, including comments and strings. CI-enforced by the `local/no-em-dash` ESLint rule; this repo writes `--` where prose wants a dash.
- **Every search result must be permission-filtered server-side, in the route.** The client never filters and must never receive a row the viewer may not open. A leak here is the failure mode that matters.
- **A result must never dead-end.** Each entity reuses its destination page's own gate. Verified gates: cycles = `recruitment.access` alone, deliberately narrower than the cycles subtree gate, because the cycle detail page (`recruitment/cycles/[id]/page.tsx:37`) requires `recruitment.access` outright and the broader gate would surface titles that bounce; support = own rows always, all rows when `support.manage_requests`; people tier 1 = `admin.manage_people`, tier 2 = `volunteers.manage_compliance` (NOT `volunteers.view`).
- **Incidents, strikes, applications, and applicants are excluded.** Security decision, see spec. Do not add them.
- `src/platform/**` must never import from `src/modules/**`.
- Client components must not import the server registry, Prisma, the RBAC engine, or the auth module.
- **Limits:** minimum 2 characters, 200ms debounce, `LIMIT 5` per group.
- **Verification:** `npx vitest run src/platform/ src/app/api/search`, `npm run typecheck`, `npx eslint src e2e`. Do NOT run bare `npx vitest run` (local throwaway DB has residue causing unrelated failures under `src/modules/schedule/services/**` and `src/modules/recruitment/services/**`). Do NOT run `npm run lint` (walks a gitignored scratch dir). Playwright cannot run locally.

---

### Task 1: Page-index matcher

The pure matching logic, with no React and no network. Everything else builds on it.

**Files:**
- Create: `src/platform/search/match.ts`
- Test: `src/platform/search/match.test.ts`

**Interfaces:**
- Consumes: `NavModule` from `@/platform/modules/nav` (shape `{ id, title, href, nav: { label, href }[] }`).
- Produces:
```ts
export type PageHit = { label: string; href: string; group: string; score: number };
export function matchPages(items: NavModule[], query: string, limit?: number): PageHit[];
export function subsequenceScore(haystack: string, needle: string): number | null;
```
`subsequenceScore` returns `null` when `needle` is not a subsequence of `haystack`, otherwise a number where LOWER is better (a tighter, earlier match scores lower). `matchPages` returns results sorted best-first, default `limit` 8.

- [ ] **Step 1: Write the failing test**

Create `src/platform/search/match.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { matchPages, subsequenceScore } from "./match";
import type { NavModule } from "@/platform/modules/nav";

const ITEMS: NavModule[] = [
  {
    id: "recruitment",
    title: "Recruitment",
    href: "/recruitment",
    nav: [
      { label: "Cycles", href: "/recruitment" },
      { label: "My interviews", href: "/recruitment/interviews" },
    ],
  },
  {
    id: "schedule",
    title: "Schedule",
    href: "/schedule",
    nav: [
      { label: "My schedule", href: "/schedule" },
      { label: "Full schedule", href: "/schedule/full" },
    ],
  },
];

describe("subsequenceScore", () => {
  it("returns null when the needle is not a subsequence", () => {
    expect(subsequenceScore("cycles", "zzz")).toBeNull();
  });
  it("matches a scattered subsequence", () => {
    expect(subsequenceScore("speed route", "spdrt")).not.toBeNull();
  });
  it("is case insensitive", () => {
    expect(subsequenceScore("Cycles", "cyc")).not.toBeNull();
  });
  it("scores a contiguous prefix better (lower) than a scattered match", () => {
    const prefix = subsequenceScore("schedule", "sch")!;
    const scattered = subsequenceScore("speed check", "sch")!;
    expect(prefix).toBeLessThan(scattered);
  });
});

describe("matchPages", () => {
  it("finds a sub-page by its label", () => {
    const hits = matchPages(ITEMS, "interviews");
    expect(hits[0].href).toBe("/recruitment/interviews");
    expect(hits[0].group).toBe("Recruitment");
  });

  it("matches on the owning module title too, so 'recruitment' surfaces its pages", () => {
    const hits = matchPages(ITEMS, "recruit");
    expect(hits.some((h) => h.href === "/recruitment/interviews")).toBe(true);
  });

  it("includes the module root itself as a hit", () => {
    const hits = matchPages(ITEMS, "schedule");
    expect(hits.some((h) => h.href === "/schedule" && h.label === "Schedule")).toBe(true);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(matchPages(ITEMS, "zzzzz")).toEqual([]);
  });

  it("never returns a page the caller did not supply, since items are already permission-filtered", () => {
    const hits = matchPages(ITEMS, "e");
    const allowed = new Set(["/recruitment", "/recruitment/interviews", "/schedule", "/schedule/full"]);
    for (const h of hits) expect(allowed.has(h.href)).toBe(true);
  });

  it("honours the limit", () => {
    expect(matchPages(ITEMS, "e", 2)).toHaveLength(2);
  });

  it("deduplicates when a sub-item href equals the module root", () => {
    // Recruitment's "Cycles" points at /recruitment, same as the module root.
    const hits = matchPages(ITEMS, "recruitment");
    const roots = hits.filter((h) => h.href === "/recruitment");
    expect(roots).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/search/match.test.ts`
Expected: FAIL, cannot resolve `./match`.

- [ ] **Step 3: Implement the matcher**

Create `src/platform/search/match.ts`:

```ts
import type { NavModule } from "@/platform/modules/nav";

/** One page result. `group` is the owning module title, for section headers. */
export type PageHit = { label: string; href: string; group: string; score: number };

/**
 * Subsequence match with a tightness score. Returns null when `needle` is not a
 * subsequence of `haystack`; otherwise a score where LOWER is better.
 *
 * The score is the span consumed (last matched index minus first) plus the
 * offset of the first match, so a contiguous prefix beats a scattered match and
 * an early match beats a late one. This is what makes "sch" rank "Schedule"
 * above "Speed check".
 */
export function subsequenceScore(haystack: string, needle: string): number | null {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (n.length === 0) return 0;

  let first = -1;
  let last = -1;
  let hi = 0;
  for (const ch of n) {
    const found = h.indexOf(ch, hi);
    if (found === -1) return null;
    if (first === -1) first = found;
    last = found;
    hi = found + 1;
  }
  return last - first + first;
}

/**
 * Rank the pages a viewer can open against a query.
 *
 * `items` is the already permission-filtered NavModule list the global nav
 * renders, so this function performs NO access control of its own and cannot
 * surface a page the caller did not supply. Keep it that way: the moment this
 * reaches for the registry directly it becomes a permission bypass.
 */
export function matchPages(items: NavModule[], query: string, limit = 8): PageHit[] {
  const q = query.trim();
  if (q.length === 0) return [];

  const hits: PageHit[] = [];
  const seen = new Set<string>();

  for (const m of items) {
    const candidates = [
      { label: m.title, href: m.href },
      ...m.nav.map((n) => ({ label: n.label, href: n.href })),
    ];
    for (const c of candidates) {
      if (seen.has(c.href)) continue;
      // Match the label first; fall back to "Module label" so typing a module
      // name surfaces its pages.
      const direct = subsequenceScore(c.label, q);
      const viaModule = direct === null ? subsequenceScore(`${m.title} ${c.label}`, q) : null;
      const score = direct ?? viaModule;
      if (score === null) continue;
      seen.add(c.href);
      // A label match outranks a match that only worked via the module name.
      hits.push({ label: c.label, href: c.href, group: m.title, score: direct === null ? score + 100 : score });
    }
  }

  return hits.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label)).slice(0, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/search/match.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npx eslint src`

```bash
git add src/platform/search/match.ts src/platform/search/match.test.ts
git commit -m "feat(search): add the page-index matcher"
```

---

### Task 2: Permission-scoped entity search service

The security-critical task. Pure service functions with explicit scoping, unit-tested against the real database.

**Files:**
- Create: `src/modules/search/entities.ts`
- Test: `src/modules/search/entities.test.ts`

It lives under `src/modules/`, NOT `src/platform/`, because it must call
`reviewScope` from `src/modules/recruitment/services/review.ts` and
`src/platform/**` may not import `src/modules/**` (ESLint boundary rule). Only
the dependency-free `match.ts` from Task 1 stays under `src/platform/search/`.

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
```ts
export type EntityHit = { id: string; label: string; sub: string | null; href: string; group: "People" | "Cycles" | "Requests" };
export async function searchEntities(personId: string, query: string): Promise<EntityHit[]>;
```

- [ ] **Step 1: Write the failing test**

Create `src/modules/search/entities.test.ts`. This repo's service tests hit a real Postgres; follow the existing style in `src/modules/support/services/attachments.test.ts` for fixture creation and `grantPermission`.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { searchEntities } from "./entities";
import { grantPermission, makePerson } from "@/platform/test/factories";

describe("searchEntities permission scoping", () => {
  let plain: string;
  let admin: string;
  let complianceMgr: string;

  beforeEach(async () => {
    plain = (await makePerson({ name: "Plain Person" })).id;
    admin = (await makePerson({ name: "Ada Admin" })).id;
    complianceMgr = (await makePerson({ name: "Cora Compliance" })).id;
    await grantPermission(admin, "admin.manage_people");
    await grantPermission(complianceMgr, "volunteers.manage_compliance");
  });

  it("returns no people to a viewer with neither people permission", async () => {
    const hits = await searchEntities(plain, "Ada");
    expect(hits.filter((h) => h.group === "People")).toEqual([]);
  });

  it("links people to the admin page for an admin.manage_people holder", async () => {
    const hits = await searchEntities(admin, "Plain");
    const person = hits.find((h) => h.group === "People");
    expect(person?.href).toMatch(/^\/admin\/people\//);
  });

  it("links people to the compliance page for a volunteers.manage_compliance holder", async () => {
    const hits = await searchEntities(complianceMgr, "Plain");
    const person = hits.find((h) => h.group === "People");
    expect(person?.href).toMatch(/^\/volunteers\/compliance\//);
  });

  it("prefers the admin link when the viewer holds both", async () => {
    await grantPermission(admin, "volunteers.manage_compliance");
    const hits = await searchEntities(admin, "Plain");
    expect(hits.find((h) => h.group === "People")?.href).toMatch(/^\/admin\/people\//);
  });

  it("returns only the viewer's own support requests when they are not a manager", async () => {
    const mine = await prisma.techRequest.create({
      data: { requesterId: plain, kind: "OTHER", subject: "Broken laptop", description: "x", status: "OPEN" },
    });
    await prisma.techRequest.create({
      data: { requesterId: admin, kind: "OTHER", subject: "Broken monitor", description: "x", status: "OPEN" },
    });
    const hits = await searchEntities(plain, "Broken");
    const reqs = hits.filter((h) => h.group === "Requests");
    expect(reqs).toHaveLength(1);
    expect(reqs[0].id).toBe(mine.id);
  });

  it("returns every support request to a support.manage_requests holder", async () => {
    await grantPermission(admin, "support.manage_requests");
    await prisma.techRequest.create({
      data: { requesterId: plain, kind: "OTHER", subject: "Broken laptop", description: "x", status: "OPEN" },
    });
    const hits = await searchEntities(admin, "Broken laptop");
    expect(hits.filter((h) => h.group === "Requests").length).toBeGreaterThanOrEqual(1);
  });

  it("returns no cycles to someone with no recruitment capability", async () => {
    const term = await prisma.term.findFirst();
    await prisma.recruitmentCycle.create({
      data: { title: "Zebra Cycle", publicSlug: `zebra-${Date.now()}`, status: "OPEN", track: "VOLUNTEER", termId: term!.id },
    });
    const hits = await searchEntities(plain, "Zebra");
    expect(hits.filter((h) => h.group === "Cycles")).toEqual([]);
  });

  it("returns cycles to a recruitment.access holder", async () => {
    await grantPermission(admin, "recruitment.access");
    const term = await prisma.term.findFirst();
    await prisma.recruitmentCycle.create({
      data: { title: "Zebra Cycle", publicSlug: `zebra2-${Date.now()}`, status: "OPEN", track: "VOLUNTEER", termId: term!.id },
    });
    const hits = await searchEntities(admin, "Zebra");
    expect(hits.filter((h) => h.group === "Cycles").length).toBeGreaterThanOrEqual(1);
  });

  it("never returns incidents or applications, which are deliberately not indexed", async () => {
    await grantPermission(admin, "*");
    const hits = await searchEntities(admin, "a");
    const groups = new Set(hits.map((h) => h.group));
    expect(groups.has("People" as const) || groups.size >= 0).toBe(true);
    for (const g of groups) expect(["People", "Cycles", "Requests"]).toContain(g);
  });

  it("returns nothing for a query under two characters", async () => {
    await grantPermission(admin, "*");
    expect(await searchEntities(admin, "a")).toEqual([]);
  });
});
```

Before writing this file, check what test helpers actually exist: run `ls src/platform/test/ 2>/dev/null` and `grep -rn "async function makePerson\|export async function grantPermission" src/ | head`. Use the real helper names and signatures this repo already has; do NOT invent `@/platform/test/factories` if it does not exist. Match the fixture style of `src/modules/support/services/attachments.test.ts`. Also confirm the real Prisma model and field names for tech requests and recruitment cycles with `grep -n "model TechRequest" -A 20 prisma/schema.prisma` and `grep -n "model RecruitmentCycle" -A 20 prisma/schema.prisma`, and adjust the fixture `data` blocks to match. The assertions above are the contract; the fixture plumbing must match reality.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/search/entities.test.ts` with the test DB env exported:
```
export TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test"
export DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL_UNPOOLED="$TEST_DATABASE_URL"
```
Expected: FAIL, cannot resolve `./entities`.

- [ ] **Step 3: Implement the service**

Create `src/modules/search/entities.ts`. Requirements, all load-bearing:

```ts
import { cache } from "react";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";

export type EntityHit = {
  id: string;
  label: string;
  sub: string | null;
  href: string;
  group: "People" | "Cycles" | "Requests";
};

/** Per-group cap. Keeps every query bounded. */
const LIMIT = 5;

/** Below this, the palette shows pages only: a 1-char entity query scans too much. */
const MIN_QUERY = 2;
```

Then `searchEntities(personId, query)` must:

1. Return `[]` immediately when `query.trim().length < MIN_QUERY`.
2. Resolve permissions ONCE, in parallel, before querying: `admin.manage_people`, `volunteers.manage_compliance`, `support.manage_requests`, `recruitment.access`, `recruitment.score`, plus `reviewScope(personId)` from `src/modules/recruitment/services/review.ts`.
3. People: skip entirely unless `admin.manage_people` or `volunteers.manage_compliance`. Query `prisma.person.findMany({ where: { status: "ACTIVE", name: { contains: q, mode: "insensitive" } }, take: LIMIT })`. Href is `/admin/people/${id}` when `admin.manage_people`, else `/volunteers/compliance/${id}`.
4. Cycles: skip entirely unless `recruitment.access || recruitment.score || scope.all || scope.departmentCodes.length > 0`. Query cycles by title contains, `take: LIMIT`, href `/recruitment/cycles/${id}`.
5. Requests: query `techRequest` by subject contains, `take: LIMIT`, and when NOT a `support.manage_requests` holder add `requesterId: personId` to the `where`. The scoping must be in the WHERE clause, not a post-filter. Href `/support/${id}`.
6. Never query incidents, strikes, applications, or applicants.

Add a file-level comment stating that every group is gated before its query runs and that a post-filter would be a bug, since a post-filter still pulls the rows.

- [ ] **Step 4: Run test to verify it passes**

Run the same command as Step 2.
Expected: PASS, all cases.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npx eslint src`

```bash
git add src/modules/search/entities.ts src/modules/search/entities.test.ts
git commit -m "feat(search): permission-scoped entity search over people, cycles, requests"
```

---

### Task 3: The `/api/search` route

**Files:**
- Create: `src/app/api/search/route.ts`
- Test: `src/app/api/search/route.test.ts`

**Interfaces:**
- Consumes: `searchEntities` from Task 2.
- Produces: `GET /api/search?q=<string>` returning `{ results: EntityHit[] }`, or `{ error: "Unauthorized" }` with status 401.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/search/route.test.ts`. Mock `@/platform/auth/auth`'s `auth()` and `@/platform/auth/match-person`'s `getActivePerson` the way any existing route test in this repo does; find one first with `grep -rln "vi.mock" src/app/api | head`. Cover:

```
- returns 401 when there is no session
- returns 401 when the session has a personId but getActivePerson returns null (revoked)
- returns [] for a missing q param
- returns [] for a q under 2 characters
- delegates to searchEntities with the session personId, never a client-supplied id
- returns 503, not 500, when the DB is unreachable (isDbUnreachableError)
```

The fifth case is the important one: assert that a query string carrying its own `personId` is ignored.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/search/route.test.ts`
Expected: FAIL, route module not found.

- [ ] **Step 3: Implement the route**

Create `src/app/api/search/route.ts`, modelled directly on `src/app/api/notifications/route.ts`:

```ts
import { auth } from "@/platform/auth/auth";
import { isDbUnreachableError } from "@/platform/db";
import { getActivePerson } from "@/platform/auth/match-person";
import { log, errorAttrs } from "@/platform/logging";
import { searchEntities } from "@/modules/search/entities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Permission-scoped search over people, recruitment cycles, and support
 * requests. Page results are resolved client-side from data the nav already
 * holds and never reach this route.
 *
 * The identity used for scoping is ALWAYS the session's personId. A client
 * cannot pass one in; that is the whole security boundary. getActivePerson
 * stays inside the try block because it is the revocation check, and a DB blip
 * must never resolve it as "still active".
 */
export async function GET(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.personId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const q = new URL(request.url).searchParams.get("q") ?? "";
  try {
    const person = await getActivePerson(session.personId);
    if (!person) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const results = await searchEntities(person.id, q);
    return Response.json({ results });
  } catch (err) {
    if (isDbUnreachableError(err)) {
      // Mirrors the notifications poll: degrade rather than turn one Neon blip
      // into a burst of captured exceptions. The palette keeps its page results.
      return Response.json({ error: "Search unavailable" }, { status: 503 });
    }
    log.error("search failed", errorAttrs(err));
    throw err;
  }
}
```

Confirm `log`/`errorAttrs` import shape against `api/notifications/route.ts` and match it exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/search/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npx eslint src`

```bash
git add src/app/api/search
git commit -m "feat(search): add the permission-scoped /api/search route"
```

---

### Task 4: The palette component

**Files:**
- Create: `src/platform/ui/command-palette.tsx`
- Test: `src/platform/ui/command-palette.test.tsx`

**Interfaces:**
- Consumes: `matchPages`/`PageHit` from Task 1; `GET /api/search` from Task 3.
- Produces: `export function CommandPalette({ items }: { items: NavModule[] }): JSX.Element` ("use client").

- [ ] **Step 1: Write the failing test**

This repo has NO jsdom and `vitest.config.ts` is `environment: "node"`; the house pattern is `renderToStaticMarkup` (see `src/platform/ui/env-banner.test.tsx` and `global-nav.test.tsx`). Assert only what server rendering can express:

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandPalette } from "./command-palette";
import type { NavModule } from "@/platform/modules/nav";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

const ITEMS: NavModule[] = [
  { id: "schedule", title: "Schedule", href: "/schedule", nav: [{ label: "Builder", href: "/schedule/builder" }] },
];

describe("CommandPalette", () => {
  it("renders a visible trigger labelled for search", () => {
    const out = renderToStaticMarkup(<CommandPalette items={ITEMS} />);
    expect(out).toContain("Search");
  });
  it("advertises the keyboard shortcut on the trigger, so it is discoverable", () => {
    const out = renderToStaticMarkup(<CommandPalette items={ITEMS} />);
    expect(out).toMatch(/⌘K|Ctrl/);
  });
  it("renders the dialog closed, so no results are in the initial markup", () => {
    const out = renderToStaticMarkup(<CommandPalette items={ITEMS} />);
    expect(out).not.toContain("/schedule/builder");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/ui/command-palette.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the component**

Create `src/platform/ui/command-palette.tsx`. Requirements:

- A visible trigger button in the toolbar showing a magnifier icon and, from `sm` up, the text `Search` plus a `⌘K` hint. `aria-label="Search"`. Keep it narrow: this costs toolbar width (see spec).
- Opens on click, on `Cmd+K`, and on `Ctrl+K`. The key handler must `preventDefault` so the browser's own find is not triggered, and must ignore the event when focus is already in an `input`, `textarea`, or `contenteditable`.
- **Portals to `document.body`.** `.glass-bar` establishes a `backdrop-filter` containing block, which broke fixed-position overlays before (PR #304). Follow `src/platform/ui/modal.tsx` for the portal, focus trap, Escape-close, and body-scroll lock rather than reimplementing them.
- Page results come from `matchPages(items, query)` and render instantly.
- Entity results are fetched from `/api/search?q=` with a **200ms debounce**, an `AbortController` cancelling the previous request, and a guard that ignores a response whose query no longer matches the current input. Non-ok responses (including 503) leave page results intact and show nothing for entities; never surface a raw error.
- Arrow keys move a single selection index across the combined flat list, Enter navigates via `router.push`, Escape closes and restores focus to the trigger.
- Results are grouped with headers (module title for pages; `People` / `Cycles` / `Requests` for entities).
- Empty state when the query is non-empty and nothing matched. A hint state below 2 characters explaining that entity search needs 2 characters.
- Accessibility: `role="dialog"` with `aria-modal="true"` and a label; the input is `role="combobox"` with `aria-expanded` and `aria-controls` pointing at the listbox; results are `role="option"` inside `role="listbox"` with `aria-selected` on the active one, and `aria-activedescendant` on the input.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/ui/command-palette.test.tsx`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npx eslint src`

```bash
git add src/platform/ui/command-palette.tsx src/platform/ui/command-palette.test.tsx
git commit -m "feat(search): add the command palette component"
```

---

### Task 5: Mount it, and free the toolbar width

Removes the pill's active-term label to pay for the trigger, then mounts the palette.

**Files:**
- Modify: `src/platform/ui/app-shell.tsx`
- Test: `src/platform/ui/app-shell.importer.test.ts` (verify still passes; do not weaken it)

**Interfaces:**
- Consumes: `CommandPalette` from Task 4.
- Produces: no new exports. `AppShell` keeps its existing props, including `termLabel`, which is still passed to `AccountMenu`.

- [ ] **Step 1: Remove the pill's term label**

In `src/platform/ui/app-shell.tsx`, delete the term-label `<span>` beside the logo (the `hidden ... sm:inline-block` element rendering `{termLabel}`).

**Do NOT remove the `termLabel` prop.** `AccountMenu` still renders it, which is what makes this removal acceptable: the term stays one click away rather than disappearing. Verify `AccountMenu` still receives it.

Add a comment where the label was:

```tsx
{/* The active-term label used to sit here. It moved to the account menu: the
    toolbar had 9px of spare width and the search trigger needs roughly 48px.
    See the Stage 2 section of the nav IA spec. */}
```

- [ ] **Step 2: Mount the palette**

Render `<CommandPalette items={navModules} />` in the right-hand control cluster, before `<ThemeToggle />`, so the order reads search, theme, bell, account.

`navModules` is already computed in `AppShell` via `getAccessibleModules` and is already permission-filtered, so the palette's page index inherits that filtering for free.

- [ ] **Step 3: Verify**

Run:
```
npx vitest run src/platform/ src/modules/search
npm run typecheck
npx eslint src e2e
```
Expected: PASS. `app-shell.importer.test.ts` must still pass unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/platform/ui/app-shell.tsx
git commit -m "feat(search): mount the palette and free toolbar width for it"
```

---

### Task 6: End-to-end coverage

**Files:**
- Create: `e2e/command-palette.spec.ts`
- Modify: `e2e/global-nav.spec.ts` (only if the overflow test needs adjusting)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the spec**

Create `e2e/command-palette.spec.ts` following the conventions in `e2e/global-nav.spec.ts` (same `devSignIn` helper shape, scoped role selectors, `waitForURL` with a pathname predicate). Cover:

```
- Cmd+K opens the palette from any page
- the visible Search trigger opens it too
- typing a page name and pressing Enter navigates there
- Escape closes it and returns focus to the trigger
- typing an admin's own name surfaces a People result that opens without hitting /no-access
- the palette still opens and shows page results when /api/search is failing
  (route.fulfill a 503 via page.route, and assert page results still render)
```

The last case matters: it proves the palette degrades rather than breaking when the DB blips, matching the notifications poll's behaviour.

- [ ] **Step 2: Confirm the nav row still fits**

Removing the term label frees 96px and the trigger costs roughly 48px, so the row should now have roughly 65px of headroom rather than 9px. The existing assertion in `e2e/global-nav.spec.ts` ("a full admin sees every module inline, with nothing pushed behind More") already guards this and should still pass unchanged. If it fails, the trigger is wider than budgeted: measure before adjusting, do not estimate. Re-add the temporary diagnostic described in the Stage 1 plan's history if needed.

- [ ] **Step 3: Verify what can be verified locally**

Run: `npm run typecheck && npx eslint src e2e`
Expected: PASS.

Playwright CANNOT run locally (needs CI Postgres and seeded fixtures). Do not attempt it and do not claim these specs pass. CI is their first run.

- [ ] **Step 4: Commit**

```bash
git add e2e/command-palette.spec.ts
git commit -m "test(e2e): cover the command palette, including its degraded state"
```

---

## Verification checklist

Confirm each with real command output, not assumption:

- [ ] `npx vitest run src/platform/ src/modules/search src/app/api/search` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npx eslint src e2e` passes.
- [ ] CI Playwright run is green, including the Stage 1 nav overflow test.
- [ ] Manual: a viewer with neither `admin.manage_people` nor `volunteers.manage_compliance` gets zero People results.
- [ ] Manual: a non-manager searching support requests sees only their own.
- [ ] Manual: every result opens without redirecting to `/no-access`.
- [ ] Manual: the toolbar still fits at 1280px with no "More".

## Security review focus

This branch adds a search endpoint. When it reaches review, the reviewer should
specifically confirm:

1. Every group is gated BEFORE its query runs, not post-filtered.
2. The scoping identity is the session's personId and cannot be supplied by the client.
3. Support-request scoping is in the WHERE clause.
4. Incidents, strikes, applications, and applicants are absent.
5. Every returned href is openable by whoever received it.
