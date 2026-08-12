# Last Login Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record when each person last signed in, on what browser, and from roughly where, and show it to admins on the person page.

**Architecture:** Four nullable columns on `Person`, written best-effort from the one place that already runs on initial sign-in (the `jwt` callback in `auth.ts`), read back on the admin person page. Two pure helpers do the thinking, so the parts worth testing are testable without a browser or an auth flow.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Prisma/Postgres, NextAuth (Auth.js v5), Vitest.

Spec: `docs/superpowers/specs/2026-08-12-last-login-tracking-design.md`

## Global Constraints

- **No em-dash (U+2014) anywhere in `src/**/*.{ts,tsx}`.** CI-enforced via `local/no-em-dash`. Use a comma, colon, parentheses, or hyphen.
- **No `tailwind-merge`.** Use `cx` from `@/platform/ui/cx`.
- **Component tests use bare `createRoot` + `act()` or `renderToStaticMarkup`, never `@testing-library/react`** (not a dependency). DOM tests need `// @vitest-environment jsdom` on line 1.
- **Capture must never block a sign-in.** Every write and every header read on the login path is wrapped so a failure is swallowed and logged. This is the single most important property in this plan: a volunteer locked out of the app because a geo header was malformed is far worse than a missing timestamp.
- **Never store an IP address.** City and country only. This was decided in the spec and is not an implementation detail to revisit.
- **Never pipe a test run through `tail` and trust the exit code.** A piped run returns 0 even when the suite fails. Read the pass/fail counts.
- **Lint with `npx eslint src e2e`**, never bare `eslint .`, which walks a gitignored directory and fails spuriously.
- **This worktree needs its own test database.** Before Task 1, run the setup in "Before you start" below. Do not reuse another worktree's database, and never run two suites at once against the same one: concurrent runs produce unique-constraint, foreign-key, and deadlock failures that look exactly like real regressions.

## Before you start

This worktree is fresh off `main` and has no dependencies installed and no test database.

```bash
npm install
psql "postgresql://haven:haven_dev@127.0.0.1:5434/postgres" -c "CREATE DATABASE havenhub_test_lastlogin OWNER haven"
DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_lastlogin" DATABASE_URL_UNPOOLED="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_lastlogin" npx prisma migrate deploy
```

Then record a baseline before changing anything, so later runs have something to compare against:

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_lastlogin" BLOB_READ_WRITE_TOKEN="" npm test
```

Write those counts down. Every later "all passing" claim in this plan means "matches that baseline, plus the tests this plan adds".

---

### Task 1: Describe a user agent

Pure string parsing, no database, no React. Done first because it is completely independent and the display task depends on it.

**Files:**
- Create: `src/platform/auth/user-agent.ts`
- Test: `src/platform/auth/user-agent.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `describeUserAgent(ua: string | null | undefined): string | null`

- [ ] **Step 1: Write the failing test**

Create `src/platform/auth/user-agent.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeUserAgent } from "./user-agent";

describe("describeUserAgent", () => {
  it("names Chrome on Windows", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
      )
    ).toBe("Chrome 131 on Windows");
  });

  it("names Safari on iPhone", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"
      )
    ).toBe("Safari 18 on iPhone");
  });

  it("names Safari on macOS", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15"
      )
    ).toBe("Safari 17 on macOS");
  });

  it("names Firefox on macOS", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0"
      )
    ).toBe("Firefox 133 on macOS");
  });

  it("names Edge, and does not mistake it for Chrome", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
      )
    ).toBe("Edge 131 on Windows");
  });

  it("names Chrome on Android", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
      )
    ).toBe("Chrome 131 on Android");
  });

  // An admin triaging a ticket is better served by the raw string than by the
  // word "Unknown", which tells them nothing they can act on.
  it("falls back to the raw string when it recognizes nothing", () => {
    expect(describeUserAgent("SomeInternalCrawler/2.0")).toBe("SomeInternalCrawler/2.0");
  });

  it("returns null for null, undefined, and blank input", () => {
    expect(describeUserAgent(null)).toBeNull();
    expect(describeUserAgent(undefined)).toBeNull();
    expect(describeUserAgent("   ")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_lastlogin" npx vitest run src/platform/auth/user-agent.test.ts
```
Expected: FAIL, cannot resolve `./user-agent`.

- [ ] **Step 3: Write the implementation**

Create `src/platform/auth/user-agent.ts`:

```ts
/**
 * Turns a stored user agent string into something an admin can read, like
 * "Safari 18 on iPhone".
 *
 * Parsing happens here, at display time, rather than at capture: user agent
 * strings change constantly, so a wrong answer is then a display bug fixable
 * later against data already collected, instead of data lost at write time.
 *
 * Deliberately small. This exists to help someone triaging a support ticket,
 * not to be a general-purpose UA database, so it covers the browsers this app
 * actually sees and falls back to the raw string for everything else.
 */

/** Order matters: Edge and Chrome both contain "Chrome", so Edge is tested first. */
const BROWSERS: Array<{ name: string; pattern: RegExp }> = [
  { name: "Edge", pattern: /Edg\/(\d+)/ },
  { name: "Firefox", pattern: /Firefox\/(\d+)/ },
  { name: "Chrome", pattern: /Chrome\/(\d+)/ },
  // Safari reports its release in Version/, not in the Safari/ token, which
  // carries a WebKit build number instead.
  { name: "Safari", pattern: /Version\/(\d+).*Safari\// },
];

/** Order matters: iPhone and iPad are also "Mac OS X", so they are tested first. */
const PLATFORMS: Array<{ name: string; pattern: RegExp }> = [
  { name: "iPhone", pattern: /iPhone/ },
  { name: "iPad", pattern: /iPad/ },
  { name: "Android", pattern: /Android/ },
  { name: "Windows", pattern: /Windows NT/ },
  { name: "macOS", pattern: /Macintosh|Mac OS X/ },
  { name: "Linux", pattern: /Linux/ },
];

export function describeUserAgent(ua: string | null | undefined): string | null {
  if (!ua || ua.trim() === "") return null;

  const browser = BROWSERS.find((b) => b.pattern.test(ua));
  const platform = PLATFORMS.find((p) => p.pattern.test(ua));
  if (!browser || !platform) return ua;

  const version = ua.match(browser.pattern)?.[1];
  if (!version) return ua;

  return `${browser.name} ${version} on ${platform.name}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_lastlogin" npx vitest run src/platform/auth/user-agent.test.ts
```
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/platform/auth/user-agent.ts src/platform/auth/user-agent.test.ts
git commit -m "feat(people): describe a stored user agent for display

Parses at display time rather than at capture, so a wrong answer stays a
display bug fixable against data already collected instead of data lost at
write time. Falls back to the raw string, which is more use to someone
triaging a ticket than the word Unknown."
```

---

### Task 2: The column, and the capture

**Files:**
- Modify: `prisma/schema.prisma` (the `Person` model)
- Create: `prisma/migrations/20260812130000_add_last_login/migration.sql`
- Create: `src/platform/auth/login-record.ts`
- Test: `src/platform/auth/login-record.test.ts`
- Modify: `src/platform/auth/auth.ts` (inside the `if (personId)` block, around line 161)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `recordLoginContext(personId: string, headers: { get(name: string): string | null }): Promise<void>`

- [ ] **Step 1: Add the Prisma fields**

In `prisma/schema.prisma`, inside the `Person` model, near the other profile fields:

```prisma
  /// Most recent successful sign-in. Last value only, never a history: enough
  /// to spot a dormant account without keeping a movement log of a volunteer.
  lastLoginAt        DateTime?
  /// Raw user agent from that sign-in. Parsed for display by describeUserAgent.
  lastLoginUserAgent String?
  /// Coarse location from Vercel's geo headers. City and country only, never an
  /// IP address.
  lastLoginCity      String?
  lastLoginCountry   String?
```

Then normalize the file's column alignment:

```bash
npx prisma format
```

- [ ] **Step 2: Hand-write the migration**

Do NOT run `prisma migrate dev`. It folds any pre-existing drift in the local database into your migration, which then ships someone else's unrelated schema change.

Create `prisma/migrations/20260812130000_add_last_login/migration.sql`:

```sql
-- All nullable on purpose. Every one of these is genuinely absent in local
-- development (there is no Vercel edge in `next dev`), and a person who has not
-- signed in since this shipped has no value rather than a misleading default.
ALTER TABLE "Person" ADD COLUMN "lastLoginAt" TIMESTAMP(3);
ALTER TABLE "Person" ADD COLUMN "lastLoginUserAgent" TEXT;
ALTER TABLE "Person" ADD COLUMN "lastLoginCity" TEXT;
ALTER TABLE "Person" ADD COLUMN "lastLoginCountry" TEXT;
```

Apply it and regenerate the client:

```bash
DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_lastlogin" DATABASE_URL_UNPOOLED="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_lastlogin" npx prisma migrate deploy
npx prisma generate
```

- [ ] **Step 3: Write the failing test**

Create `src/platform/auth/login-record.test.ts`. Note the header bag is injected rather than imported from `next/headers`, which is what makes this testable at all:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { recordLoginContext } from "./login-record";

/** Minimal stand-in for the Headers object, matching the one method we use. */
function headerBag(values: Record<string, string>) {
  return { get: (name: string) => values[name.toLowerCase()] ?? null };
}

async function makePerson() {
  return prisma.person.create({ data: { name: "Test Person" } });
}

describe("recordLoginContext", () => {
  beforeEach(resetDb);

  it("records the timestamp, user agent, city, and country", async () => {
    const person = await makePerson();

    await recordLoginContext(
      person.id,
      headerBag({
        "user-agent": "Mozilla/5.0 (Macintosh) Chrome/131.0.0.0",
        "x-vercel-ip-city": "New Haven",
        "x-vercel-ip-country": "US",
      })
    );

    const updated = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(updated.lastLoginAt).toBeInstanceOf(Date);
    expect(updated.lastLoginUserAgent).toBe("Mozilla/5.0 (Macintosh) Chrome/131.0.0.0");
    expect(updated.lastLoginCity).toBe("New Haven");
    expect(updated.lastLoginCountry).toBe("US");
  });

  // Vercel percent-encodes the city, so storing it raw would show an admin
  // "New%20Haven".
  it("decodes a percent-encoded city", async () => {
    const person = await makePerson();

    await recordLoginContext(
      person.id,
      headerBag({ "x-vercel-ip-city": "New%20Haven", "x-vercel-ip-country": "US" })
    );

    const updated = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(updated.lastLoginCity).toBe("New Haven");
  });

  // Local development has no Vercel edge, so every geo header is absent.
  it("writes null for absent headers, and still stamps the time", async () => {
    const person = await makePerson();

    await recordLoginContext(person.id, headerBag({}));

    const updated = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(updated.lastLoginAt).toBeInstanceOf(Date);
    expect(updated.lastLoginUserAgent).toBeNull();
    expect(updated.lastLoginCity).toBeNull();
    expect(updated.lastLoginCountry).toBeNull();
  });

  // A malformed city must not throw out of a percent-decode and take the login
  // with it.
  it("keeps the raw city when it cannot be decoded", async () => {
    const person = await makePerson();

    await recordLoginContext(person.id, headerBag({ "x-vercel-ip-city": "100%" }));

    const updated = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(updated.lastLoginCity).toBe("100%");
  });

  // THE contract that matters: nothing here may ever break a sign-in.
  it("swallows a database failure instead of throwing into the login path", async () => {
    const spy = vi
      .spyOn(prisma.person, "update")
      .mockRejectedValueOnce(new Error("database is on fire"));

    await expect(
      recordLoginContext("some-person-id", headerBag({}))
    ).resolves.toBeUndefined();

    spy.mockRestore();
  });

  it("swallows a throwing header bag instead of throwing into the login path", async () => {
    const exploding = {
      get: () => {
        throw new Error("headers unavailable");
      },
    };

    await expect(recordLoginContext("some-person-id", exploding)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_lastlogin" npx vitest run src/platform/auth/login-record.test.ts
```
Expected: FAIL, cannot resolve `./login-record`.

- [ ] **Step 5: Write the implementation**

Create `src/platform/auth/login-record.ts`:

```ts
import { prisma } from "@/platform/db";
import { log, errorAttrs } from "@/platform/logging";

/**
 * Only the piece of Headers this needs, so callers can inject a plain object in
 * tests instead of standing up a request.
 */
type HeaderBag = { get(name: string): string | null };

/**
 * Vercel percent-encodes the geo headers, so "New Haven" arrives as
 * "New%20Haven". A malformed value makes decodeURIComponent throw (for example
 * a bare "%"), and a login is not worth losing over a city name, so the raw
 * value stands in that case.
 */
function decodeHeader(value: string | null): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Stamps the most recent sign-in on the person: when, what browser, and roughly
 * where.
 *
 * BEST-EFFORT, AND THAT IS THE POINT. This runs on the sign-in path, so every
 * failure is swallowed and logged rather than propagated. A volunteer locked out
 * of the app because a geo header was malformed or Neon blinked would be far
 * worse than a missing timestamp. Callers must not depend on it having written.
 *
 * Geo headers are absent outside Vercel, so in local development every location
 * field is null by design, not by failure.
 */
export async function recordLoginContext(personId: string, headers: HeaderBag): Promise<void> {
  try {
    await prisma.person.update({
      where: { id: personId },
      data: {
        lastLoginAt: new Date(),
        lastLoginUserAgent: headers.get("user-agent"),
        lastLoginCity: decodeHeader(headers.get("x-vercel-ip-city")),
        lastLoginCountry: headers.get("x-vercel-ip-country"),
      },
    });
  } catch (err) {
    log.warn("[auth] failed to record login context (best-effort)", errorAttrs(err));
  }
}
```

Both `log` and `errorAttrs` are exported from `@/platform/logging` (verified: `src/platform/logging/index.ts:1` re-exports them from `./logger`), so the import above is correct as written.

- [ ] **Step 6: Run the test to verify it passes**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_lastlogin" npx vitest run src/platform/auth/login-record.test.ts
```
Expected: PASS, 6 tests.

- [ ] **Step 7: Call it from the sign-in path**

In `src/platform/auth/auth.ts`, add the imports:

```ts
import { headers } from "next/headers";
import { recordLoginContext } from "./login-record";
```

Then inside the `jwt` callback's `if (personId) { ... }` block (around line 161), add this immediately BEFORE the existing `let termId: string | undefined;` line:

```ts
          // Stamp the sign-in before the PostHog enrichment below, so a slow
          // analytics call cannot delay it. headers() is available because this
          // callback runs inside the auth route handler, and the whole call is
          // best-effort: recordLoginContext swallows its own failures, and this
          // try/catch covers headers() itself being unavailable.
          try {
            await recordLoginContext(personId, await headers());
          } catch (err) {
            log.warn("[auth] could not read headers to record login", errorAttrs(err));
          }
```

If `log` and `errorAttrs` are not already imported in `auth.ts`, add them from `@/platform/logging`.

Note this sits inside `if (account)`, so it runs only on initial sign-in, not on every JWT refresh. That is what keeps it to one write per login rather than one per request.

- [ ] **Step 8: Verify**

```bash
npm run typecheck
npx eslint src e2e
```
Expected: typecheck clean; lint 0 errors (2 pre-existing `<img>` warnings in untouched files are expected).

Then the full suite, with nothing else running (`ps aux | grep vitest` first):

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_lastlogin" BLOB_READ_WRITE_TOKEN="" npm test
```
Expected: your recorded baseline, plus 8 tests from Task 1 and 6 from this task.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260812130000_add_last_login src/platform/auth/login-record.ts src/platform/auth/login-record.test.ts src/platform/auth/auth.ts
git commit -m "feat(people): record the most recent sign-in on the person

Successful Yale SSO logins were recorded nowhere, so there was no way to tell a
dormant account from an active one or to confirm someone got in after an access
problem was fixed.

Best-effort by construction: every failure is swallowed and logged, because a
volunteer locked out by a malformed geo header would be far worse than a missing
timestamp. City and country only, never an IP."
```

---

### Task 3: Show it to admins

**Files:**
- Modify: `src/app/(app)/admin/people/[id]/page.tsx`
- Test: `src/modules/admin/components/last-login-panel.test.tsx`
- Create: `src/modules/admin/components/last-login-panel.tsx`

**Interfaces:**
- Consumes: `describeUserAgent` from Task 1; the four `Person` columns from Task 2.
- Produces: `LastLoginPanel({ person })`, a server component.

- [ ] **Step 1: Write the failing test**

Create `src/modules/admin/components/last-login-panel.test.tsx`. Follow the `renderToStaticMarkup` idiom used by `src/platform/ui/env-banner.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LastLoginPanel } from "./last-login-panel";

const BASE = {
  lastLoginAt: new Date("2026-08-01T14:30:00Z"),
  lastLoginUserAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  lastLoginCity: "New Haven",
  lastLoginCountry: "US",
};

describe("LastLoginPanel", () => {
  it("shows the parsed browser rather than the raw user agent", () => {
    const out = renderToStaticMarkup(<LastLoginPanel person={BASE} />);
    expect(out).toContain("Safari 18 on iPhone");
    expect(out).not.toContain("AppleWebKit");
  });

  it("shows the city and country", () => {
    const out = renderToStaticMarkup(<LastLoginPanel person={BASE} />);
    expect(out).toContain("New Haven");
    expect(out).toContain("US");
  });

  // Absence here has a real meaning (never signed in, or not since this
  // shipped), and a blank row reads like a bug.
  it("says so explicitly when there is no sign-in on record", () => {
    const out = renderToStaticMarkup(
      <LastLoginPanel
        person={{
          lastLoginAt: null,
          lastLoginUserAgent: null,
          lastLoginCity: null,
          lastLoginCountry: null,
        }}
      />
    );
    expect(out).toContain("No sign-in recorded");
  });

  // Local sign-ins have no geo headers, so this is the normal shape in dev.
  it("omits location entirely when it was not captured", () => {
    const out = renderToStaticMarkup(
      <LastLoginPanel person={{ ...BASE, lastLoginCity: null, lastLoginCountry: null }} />
    );
    expect(out).toContain("Safari 18 on iPhone");
    expect(out).not.toContain("Location");
  });
});
```

Note: `LastLoginPanel` must NOT be an async component, or `renderToStaticMarkup` cannot render it. Format the timestamp with a synchronous helper rather than the async `DateTime` server component in `@/platform/dates/display`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_lastlogin" npx vitest run "src/modules/admin/components/last-login-panel.test.tsx"
```
Expected: FAIL, cannot resolve the component.

- [ ] **Step 3: Write the component**

Create `src/modules/admin/components/last-login-panel.tsx`:

```tsx
import { describeUserAgent } from "@/platform/auth/user-agent";

type LastLoginFields = {
  lastLoginAt: Date | null;
  lastLoginUserAgent: string | null;
  lastLoginCity: string | null;
  lastLoginCountry: string | null;
};

/**
 * Admin-only view of the most recent sign-in.
 *
 * Rendered from the person page, which already requires admin.manage_people, so
 * the gating is inherited rather than reinvented. Nothing here appears on the
 * member's own page or to department directors.
 *
 * Synchronous on purpose: an async server component cannot be rendered by
 * renderToStaticMarkup, which is how this is tested.
 */
export function LastLoginPanel({ person }: { person: LastLoginFields }) {
  if (!person.lastLoginAt) {
    return <p className="text-sm text-muted-foreground">No sign-in recorded.</p>;
  }

  const browser = describeUserAgent(person.lastLoginUserAgent);
  const location = [person.lastLoginCity, person.lastLoginCountry].filter(Boolean).join(", ");

  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6">
      <dt className="font-medium text-foreground">Last sign-in</dt>
      <dd className="text-muted-foreground">
        <time dateTime={person.lastLoginAt.toISOString()}>
          {person.lastLoginAt.toISOString().replace("T", " ").slice(0, 16)} UTC
        </time>
      </dd>
      {browser ? (
        <>
          <dt className="font-medium text-foreground">Browser</dt>
          <dd className="text-muted-foreground">{browser}</dd>
        </>
      ) : null}
      {location ? (
        <>
          <dt className="font-medium text-foreground">Location</dt>
          <dd className="text-muted-foreground">{location}</dd>
        </>
      ) : null}
    </dl>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_lastlogin" npx vitest run "src/modules/admin/components/last-login-panel.test.tsx"
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Render it on the person page**

In `src/app/(app)/admin/people/[id]/page.tsx`, add the import:

```tsx
import { LastLoginPanel } from "@/modules/admin/components/last-login-panel";
```

Then add a section after the existing `Status` section (the one opening at roughly line 141 with `<SectionHeader className="mb-4">Status</SectionHeader>`), matching the surrounding `<section>` + `SectionHeader` shape:

```tsx
      {/* Admin-only. This page already requires admin.manage_people, so the
          gating is inherited. Nothing here is shown to the member or to
          department directors. */}
      <section>
        <SectionHeader className="mb-4">Sign-in activity</SectionHeader>
        <LastLoginPanel person={person} />
      </section>
```

`person` is already loaded on this page and is a full Prisma `Person`, so it carries the four new fields with no extra query.

- [ ] **Step 6: Verify**

```bash
npm run typecheck
npx eslint src e2e
```
Expected: typecheck clean; lint 0 errors.

Then the full suite, with nothing else running:

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_lastlogin" BLOB_READ_WRITE_TOKEN="" npm test
```
Expected: baseline plus 18 tests total from this plan (8 + 6 + 4), zero failures.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/admin/people/[id]/page.tsx" src/modules/admin/components/last-login-panel.tsx "src/modules/admin/components/last-login-panel.test.tsx"
git commit -m "feat(people): show the last sign-in to admins

Admin only: rendered from a page that already requires admin.manage_people, so
nothing is shown to the member or to department directors.

Says No sign-in recorded rather than rendering a blank row, because absence has
a real meaning here (never signed in, or not since this shipped) and an empty
cell reads like a bug."
```

---

## Notes for the implementer

- **Nothing in this plan may block a sign-in.** If you find yourself removing a try/catch on the login path, or making a caller await something that can reject, stop. That property is the reason the capture is shaped the way it is.
- **Do not store an IP address**, and do not add latitude or longitude from the Vercel headers. City and country were chosen deliberately over the more precise options.
- **Do not add a login history table.** Last value only. A history would be more useful for forensics and would also accumulate a movement log of a student volunteer, which was explicitly ruled out.
- **The geo fields are null in local development.** There is no Vercel edge in `next dev`, so a locally captured sign-in has a timestamp and a user agent and no location. That is correct behavior, not a bug to work around.
