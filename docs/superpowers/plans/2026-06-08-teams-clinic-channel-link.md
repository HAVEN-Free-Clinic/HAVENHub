# Teams Clinic Channel Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a "This week's clinic Teams channel" link on the HAVEN Hub home dashboard, resolved automatically each week from Microsoft Graph via the existing Mailer OAuth token.

**Architecture:** A new `src/platform/teams/channel-link.ts` module computes the current clinic date from the active term's `clinicDates` (America/New_York calendar, rolling over at midnight Sat→Sun), lists the clinic Team's channels via Graph using the reused delegated access token, matches the channel whose name starts with the `MM-DD-YY` date, and returns its Graph-provided `webUrl`. Pure helpers (date selection/formatting/matching) are unit-tested without a DB; the orchestrator takes injectable deps. The home page renders a card only when a link resolves; all failures degrade to `null`.

**Tech Stack:** Next.js 16 App Router (RSC), TypeScript, Prisma/PostgreSQL, Vitest, Microsoft Graph v1.0.

**Spec:** `docs/superpowers/specs/2026-06-08-teams-clinic-channel-link-design.md`

---

## File Structure

- **Modify** `src/platform/email/oauth.ts` — append `Channel.ReadBasic.All` to the `SCOPES` constant (one shared scope string for authorize + refresh).
- **Modify** `src/platform/email/oauth.test.ts` — assert the new scope is present in the authorize URL.
- **Modify** `src/platform/config.ts` — add optional `TEAMS_CLINIC_GROUP_ID`.
- **Modify** `src/platform/config.test.ts` — assert it parses.
- **Modify** `.env.example` — document `TEAMS_CLINIC_GROUP_ID` and the added scope.
- **Create** `src/platform/teams/channel-link.ts` — pure helpers + orchestrator + cache.
- **Create** `src/platform/teams/channel-link.test.ts` — unit tests (no DB; injected deps).
- **Modify** `src/app/page.tsx` — render the channel-link card.

---

## Task 1: Add `Channel.ReadBasic.All` scope to the Mailer OAuth

**Files:**
- Modify: `src/platform/email/oauth.ts:26-27`
- Test: `src/platform/email/oauth.test.ts`

- [ ] **Step 1: Write the failing test**

Add this `it` block inside the existing `describe("buildAuthorizeUrl", ...)` block in `src/platform/email/oauth.test.ts` (next to the existing `includes Mail.Send.Shared in the scope` test near line 107):

```ts
  it("includes Channel.ReadBasic.All in the scope", () => {
    const url = buildAuthorizeUrl({ state: "xyz" });
    expect(decodeURIComponent(url)).toContain("Channel.ReadBasic.All");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/platform/email/oauth.test.ts -t "Channel.ReadBasic.All"`
Expected: FAIL — the decoded URL does not contain `Channel.ReadBasic.All`.

- [ ] **Step 3: Update the SCOPES constant**

In `src/platform/email/oauth.ts`, replace the `SCOPES` constant (lines 26-27):

```ts
const SCOPES =
  "openid profile email offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Send.Shared https://graph.microsoft.com/Channel.ReadBasic.All";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/platform/email/oauth.test.ts`
Expected: PASS — all existing oauth tests plus the new scope assertion. (Existing scope assertions use `toContain`, so they are unaffected.)

- [ ] **Step 5: Commit**

```bash
git add src/platform/email/oauth.ts src/platform/email/oauth.test.ts
git commit -m "feat(teams): add Channel.ReadBasic.All to Mailer OAuth scope"
```

---

## Task 2: Add `TEAMS_CLINIC_GROUP_ID` config var

**Files:**
- Modify: `src/platform/config.ts:51` (after `EMAIL_SENDER`)
- Modify: `.env.example`
- Test: `src/platform/config.test.ts`

- [ ] **Step 1: Write the failing test**

Add this `it` block inside the `describe("loadConfig", ...)` block in `src/platform/config.test.ts`:

```ts
  it("exposes TEAMS_CLINIC_GROUP_ID when provided", () => {
    const config = loadConfig({
      ...base,
      TEAMS_CLINIC_GROUP_ID: "4796e633-27e4-4053-8631-d3b4fe64ebe6",
    });
    expect(config.TEAMS_CLINIC_GROUP_ID).toBe(
      "4796e633-27e4-4053-8631-d3b4fe64ebe6"
    );
  });

  it("leaves TEAMS_CLINIC_GROUP_ID undefined when absent", () => {
    const config = loadConfig(base);
    expect(config.TEAMS_CLINIC_GROUP_ID).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/platform/config.test.ts -t "TEAMS_CLINIC_GROUP_ID"`
Expected: FAIL — `TEAMS_CLINIC_GROUP_ID` is not a known property / is `undefined` for the "provided" case.

- [ ] **Step 3: Add the schema field**

In `src/platform/config.ts`, immediately after the `EMAIL_SENDER: z.string().optional(),` line (line 51), add:

```ts
    // The Microsoft Teams clinic Team's groupId. When set (and the Mailer OAuth is
    // connected with the Channel.ReadBasic.All scope), the home dashboard shows a
    // link to the current clinic week's channel. Optional: when unset, the card is
    // simply not rendered. The connected mailbox must be a member of this Team.
    TEAMS_CLINIC_GROUP_ID: z.string().optional(),
```

- [ ] **Step 4: Document it in `.env.example`**

In `.env.example`, after the `GRAPH_OAUTH_REDIRECT_URI=...` line (line 69), add:

```
# Microsoft Teams clinic Team groupId (the Team that holds one channel per clinic
# week, each named "MM-DD-YY Clinic"). When set, the home dashboard links to the
# current week's channel. Requires the Mailer OAuth to be re-consented with the
# Channel.ReadBasic.All scope, and the connected mailbox to be a member of the Team.
TEAMS_CLINIC_GROUP_ID=
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/platform/config.test.ts`
Expected: PASS — all config tests including the two new ones.

- [ ] **Step 6: Commit**

```bash
git add src/platform/config.ts src/platform/config.test.ts .env.example
git commit -m "feat(teams): add optional TEAMS_CLINIC_GROUP_ID config"
```

---

## Task 3: Pure helpers — date selection, formatting, channel matching

**Files:**
- Create: `src/platform/teams/channel-link.ts`
- Test: `src/platform/teams/channel-link.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/platform/teams/channel-link.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  selectCurrentClinicDate,
  formatClinicDate,
  matchChannel,
} from "./channel-link";

// Clinic dates are anchored at 12:00 UTC like Term.clinicDates.
function clinic(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

const dates = [clinic(2026, 6, 6), clinic(2026, 6, 13), clinic(2026, 6, 20)];

describe("selectCurrentClinicDate", () => {
  it("picks the upcoming clinic mid-week (Mon)", () => {
    // Mon 2026-06-08 12:00 UTC -> upcoming is Sat 06-13.
    const now = new Date(Date.UTC(2026, 5, 8, 12, 0, 0));
    expect(selectCurrentClinicDate(dates, now)).toEqual(clinic(2026, 6, 13));
  });

  it("still shows that day's clinic on the clinic Saturday", () => {
    // Sat 2026-06-13 18:00 UTC = 14:00 ET, same NY calendar day.
    const now = new Date(Date.UTC(2026, 5, 13, 18, 0, 0));
    expect(selectCurrentClinicDate(dates, now)).toEqual(clinic(2026, 6, 13));
  });

  it("rolls to the next clinic once it is Sunday in New_York", () => {
    // Sun 2026-06-14 05:00 UTC = Sun 01:00 ET -> 06-13 is past, pick 06-20.
    const now = new Date(Date.UTC(2026, 5, 14, 5, 0, 0));
    expect(selectCurrentClinicDate(dates, now)).toEqual(clinic(2026, 6, 20));
  });

  it("does NOT roll while it is still Saturday night in New_York", () => {
    // Sun 2026-06-14 03:00 UTC = Sat 23:00 ET -> still 06-13.
    const now = new Date(Date.UTC(2026, 5, 14, 3, 0, 0));
    expect(selectCurrentClinicDate(dates, now)).toEqual(clinic(2026, 6, 13));
  });

  it("returns null when all clinic dates are past", () => {
    const now = new Date(Date.UTC(2026, 6, 1, 12, 0, 0));
    expect(selectCurrentClinicDate(dates, now)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(selectCurrentClinicDate([], new Date())).toBeNull();
  });
});

describe("formatClinicDate", () => {
  it("formats as zero-padded MM-DD-YY", () => {
    expect(formatClinicDate(clinic(2026, 6, 13))).toBe("06-13-26");
  });

  it("zero-pads single-digit month and day", () => {
    expect(formatClinicDate(clinic(2026, 1, 3))).toBe("01-03-26");
  });
});

describe("matchChannel", () => {
  const channels = [
    { id: "1", displayName: "General", webUrl: "https://x/general" },
    { id: "2", displayName: "06-13-26 Clinic", webUrl: "https://x/0613" },
    { id: "3", displayName: "06-20-26 Clinic", webUrl: "https://x/0620" },
  ];

  it("matches the channel whose name starts with the date string", () => {
    expect(matchChannel(channels, "06-13-26")?.id).toBe("2");
  });

  it("is case- and whitespace-tolerant", () => {
    const odd = [{ id: "9", displayName: "  06-13-26 clinic ", webUrl: "u" }];
    expect(matchChannel(odd, "06-13-26")?.id).toBe("9");
  });

  it("returns null when no channel matches", () => {
    expect(matchChannel(channels, "07-04-26")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/platform/teams/channel-link.test.ts`
Expected: FAIL — module `./channel-link` does not exist / exports undefined.

- [ ] **Step 3: Implement the helpers**

Create `src/platform/teams/channel-link.ts`:

```ts
/**
 * Resolve a link to the current clinic week's Microsoft Teams channel.
 *
 * The clinic Team holds one channel per clinic week, each named "MM-DD-YY Clinic"
 * (e.g. "06-13-26 Clinic"). We compute the current clinic date from the active
 * term's clinicDates (America/New_York calendar; a clinic Saturday's channel
 * shows through that Saturday and rolls to the next at midnight into Sunday),
 * list the Team's channels via Microsoft Graph using the reused Mailer delegated
 * token, and return the matched channel's Graph-provided webUrl deeplink.
 *
 * Every failure path degrades to null so the dashboard simply hides the card.
 */

/** A Microsoft Graph channel object (subset we use). */
export interface GraphChannel {
  id: string;
  displayName: string;
  webUrl: string;
}

/**
 * Return the YYYYMMDD integer for the America/New_York calendar date of an
 * instant. Clinic dates are anchored at 12:00 UTC, so their NY calendar date is
 * unambiguous; "now" is converted to its NY calendar date for comparison.
 */
function nyDateInt(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return Number(`${y}${m}${day}`);
}

/**
 * Pick the earliest clinic date whose NY calendar date is >= today's NY calendar
 * date. Returns null when there is no upcoming clinic date.
 */
export function selectCurrentClinicDate(
  clinicDates: Date[],
  now: Date
): Date | null {
  const today = nyDateInt(now);
  const upcoming = clinicDates
    .filter((d) => nyDateInt(d) >= today)
    .sort((a, b) => a.getTime() - b.getTime());
  return upcoming[0] ?? null;
}

/** Format a clinic date as zero-padded MM-DD-YY in America/New_York. */
export function formatClinicDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  const y = parts.find((p) => p.type === "year")!.value;
  return `${m}-${d}-${y}`;
}

/**
 * Find the channel whose displayName starts with the MM-DD-YY date string
 * (trim + case-insensitive). Returns null when none match.
 */
export function matchChannel(
  channels: GraphChannel[],
  dateStr: string
): GraphChannel | null {
  const target = dateStr.trim().toLowerCase();
  return (
    channels.find((c) =>
      (c.displayName ?? "").trim().toLowerCase().startsWith(target)
    ) ?? null
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/platform/teams/channel-link.test.ts`
Expected: PASS — all `selectCurrentClinicDate`, `formatClinicDate`, and `matchChannel` tests.

- [ ] **Step 5: Commit**

```bash
git add src/platform/teams/channel-link.ts src/platform/teams/channel-link.test.ts
git commit -m "feat(teams): clinic-date selection, formatting, and channel matching helpers"
```

---

## Task 4: Orchestrator `getCurrentClinicChannelLink` with cache + failure handling

**Files:**
- Modify: `src/platform/teams/channel-link.ts`
- Test: `src/platform/teams/channel-link.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/platform/teams/channel-link.test.ts`. First extend the imports at the top of the file:

```ts
import {
  selectCurrentClinicDate,
  formatClinicDate,
  matchChannel,
  getCurrentClinicChannelLink,
  __resetChannelCache,
  type ClinicChannelLink,
} from "./channel-link";
import { afterEach, beforeEach, vi } from "vitest";
```

Then append these blocks:

```ts
beforeEach(() => {
  __resetChannelCache();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("getCurrentClinicChannelLink", () => {
  const groupId = "4796e633-27e4-4053-8631-d3b4fe64ebe6";
  const now = new Date(Date.UTC(2026, 5, 8, 12, 0, 0)); // Mon -> upcoming 06-13
  const clinicDates = [clinic(2026, 6, 6), clinic(2026, 6, 13), clinic(2026, 6, 20)];

  function okChannelsFetch() {
    return vi.fn(async () =>
      new Response(
        JSON.stringify({
          value: [
            { id: "1", displayName: "General", webUrl: "https://x/general" },
            { id: "2", displayName: "06-13-26 Clinic", webUrl: "https://x/0613" },
          ],
        }),
        { status: 200 }
      )
    );
  }

  it("returns the matched channel's webUrl for the current week", async () => {
    const fetchImpl = okChannelsFetch();
    const result = await getCurrentClinicChannelLink({
      fetchImpl,
      getToken: async () => "tok",
      now,
      groupId,
      loadClinicDates: async () => clinicDates,
    });
    expect(result).toEqual<ClinicChannelLink>({
      webUrl: "https://x/0613",
      displayName: "06-13-26 Clinic",
      clinicDate: clinic(2026, 6, 13),
    });
    // Authorization header carries the reused token.
    const [, init] = fetchImpl.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok"
    );
  });

  it("returns null when groupId is unset (no Graph call)", async () => {
    const fetchImpl = vi.fn();
    const result = await getCurrentClinicChannelLink({
      fetchImpl,
      getToken: async () => "tok",
      now,
      groupId: undefined,
      loadClinicDates: async () => clinicDates,
    });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when there is no active term / no clinic dates", async () => {
    const fetchImpl = vi.fn();
    const result = await getCurrentClinicChannelLink({
      fetchImpl,
      getToken: async () => "tok",
      now,
      groupId,
      loadClinicDates: async () => null,
    });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when no channel matches the current week", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ value: [{ id: "1", displayName: "General", webUrl: "u" }] }), {
        status: 200,
      })
    );
    const result = await getCurrentClinicChannelLink({
      fetchImpl,
      getToken: async () => "tok",
      now,
      groupId,
      loadClinicDates: async () => clinicDates,
    });
    expect(result).toBeNull();
  });

  it("returns null (never throws) on a non-2xx Graph response", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const result = await getCurrentClinicChannelLink({
      fetchImpl,
      getToken: async () => "tok",
      now,
      groupId,
      loadClinicDates: async () => clinicDates,
    });
    expect(result).toBeNull();
  });

  it("returns null (never throws) when the token getter throws", async () => {
    const fetchImpl = vi.fn();
    const result = await getCurrentClinicChannelLink({
      fetchImpl,
      getToken: async () => {
        throw new Error("MailNotConnected");
      },
      now,
      groupId,
      loadClinicDates: async () => clinicDates,
    });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caches within the TTL: a second call does not re-fetch", async () => {
    const fetchImpl = okChannelsFetch();
    const deps = {
      fetchImpl,
      getToken: async () => "tok",
      now,
      groupId,
      loadClinicDates: async () => clinicDates,
    };
    await getCurrentClinicChannelLink(deps);
    await getCurrentClinicChannelLink(deps);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
```

Note: silence the expected error logs by stubbing `console.error` in the failure-path tests is optional; the orchestrator logs via `console.error`. Add at the top of the failure tests if the noise is undesirable: `vi.spyOn(console, "error").mockImplementation(() => {});`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/platform/teams/channel-link.test.ts -t "getCurrentClinicChannelLink"`
Expected: FAIL — `getCurrentClinicChannelLink` / `__resetChannelCache` / `ClinicChannelLink` are not exported.

- [ ] **Step 3: Implement the orchestrator**

Append to `src/platform/teams/channel-link.ts` (and add the two imports at the top of the file):

```ts
import { config } from "@/platform/config";
import { prisma } from "@/platform/db";
import { getAccessToken } from "@/platform/email/oauth";
```

```ts
/** The resolved link for the current clinic week's Teams channel. */
export interface ClinicChannelLink {
  webUrl: string;
  displayName: string;
  clinicDate: Date;
}

/** Injectable dependencies (defaults wire up real config/prisma/Graph). */
export interface ChannelLinkDeps {
  fetchImpl?: typeof fetch;
  getToken?: () => Promise<string>;
  now?: Date;
  groupId?: string | undefined;
  loadClinicDates?: () => Promise<Date[] | null>;
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface CacheEntry {
  dateStr: string;
  value: ClinicChannelLink | null;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

/** Clear the module-level cache. Exported for test isolation only. */
export function __resetChannelCache(): void {
  cache = null;
}

/** Default clinic-date source: the active term's clinicDates array. */
async function loadActiveTermClinicDates(): Promise<Date[] | null> {
  const term = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
    select: { clinicDates: true },
  });
  return term?.clinicDates ?? null;
}

function logChannelError(stage: string, err: unknown): void {
  console.error(`[teams/channel-link] ${stage} failed:`, err);
}

/**
 * Resolve the current clinic week's Teams channel link, or null when it cannot
 * be determined (unconfigured, not connected, no active term, channel missing,
 * or any Graph error). Never throws.
 */
export async function getCurrentClinicChannelLink(
  deps: ChannelLinkDeps = {}
): Promise<ClinicChannelLink | null> {
  const {
    fetchImpl = fetch,
    getToken = getAccessToken,
    now = new Date(),
    groupId = config.TEAMS_CLINIC_GROUP_ID,
    loadClinicDates = loadActiveTermClinicDates,
  } = deps;

  if (!groupId) return null;

  let clinicDates: Date[] | null;
  try {
    clinicDates = await loadClinicDates();
  } catch (err) {
    logChannelError("load clinic dates", err);
    return null;
  }
  if (!clinicDates || clinicDates.length === 0) return null;

  const clinicDate = selectCurrentClinicDate(clinicDates, now);
  if (!clinicDate) return null;
  const dateStr = formatClinicDate(clinicDate);

  // Serve from cache when the week and TTL still hold (caches null misses too).
  if (cache && cache.dateStr === dateStr && now.getTime() < cache.expiresAt) {
    return cache.value;
  }

  let value: ClinicChannelLink | null = null;
  try {
    const token = await getToken();
    const url = `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(
      groupId
    )}/channels`;
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Graph channels list failed: ${res.status}`);
    }
    const json = (await res.json()) as { value?: GraphChannel[] };
    const channel = matchChannel(json.value ?? [], dateStr);
    if (channel?.webUrl) {
      value = {
        webUrl: channel.webUrl,
        displayName: channel.displayName,
        clinicDate,
      };
    }
  } catch (err) {
    logChannelError("resolve channel", err);
    value = null;
  }

  cache = { dateStr, value, expiresAt: now.getTime() + CACHE_TTL_MS };
  return value;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/platform/teams/channel-link.test.ts`
Expected: PASS — all helper and orchestrator tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/platform/teams/channel-link.ts src/platform/teams/channel-link.test.ts
git commit -m "feat(teams): resolve current clinic channel link via Graph with cache"
```

---

## Task 5: Render the channel-link card on the home dashboard

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Import and call the resolver**

In `src/app/page.tsx`, add the import after the existing imports (after line 6):

```ts
import { getCurrentClinicChannelLink } from "@/platform/teams/channel-link";
```

Then, inside `HubPage`, after the `activeTerm` fetch (line 17-20), add:

```ts
  const clinicChannel = await getCurrentClinicChannelLink();
```

- [ ] **Step 2: Render the card when a link resolves**

In `src/app/page.tsx`, between the intro `<p>...</p>` (ends line 36) and the `Modules` `<h2>` (line 38), insert:

```tsx
      {clinicChannel ? (
        <a
          href={clinicChannel.webUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 flex items-center justify-between rounded-lg border border-brand/30 bg-brand-faint p-4 transition hover:border-brand/50 hover:shadow-sm"
        >
          <span>
            <span className="block text-xs font-semibold uppercase tracking-wider text-brand">
              This week&apos;s clinic Teams channel
            </span>
            <span className="mt-0.5 block text-sm font-medium text-slate-700">
              {clinicChannel.displayName}
            </span>
          </span>
          <span aria-hidden className="text-brand">
            &rarr;
          </span>
        </a>
      ) : null}
```

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors. (`page.tsx` remains a server component; `getCurrentClinicChannelLink` is server-only.)

- [ ] **Step 4: Build to verify the page compiles**

Run: `npm run build`
Expected: build succeeds; `/` compiles as a dynamic/server route.

- [ ] **Step 5: Manual verification (requires live tenant prerequisites)**

This step needs the operational prerequisites satisfied: an admin has re-consented the Mailer at `/admin/email` (granting `Channel.ReadBasic.All`), `TEAMS_CLINIC_GROUP_ID` is set, and `hfc.it@yale.edu` is a member of the clinic Team.

- Start the app (`npm run dev`), sign in, and load `/`.
- Confirm the "This week's clinic Teams channel" card appears and links to the correct dated channel; clicking opens Teams to that channel.
- If prerequisites are not yet met, confirm the page renders normally with no card and no error.

- [ ] **Step 6: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat(teams): show current clinic week Teams channel link on home dashboard"
```

---

## Final verification

- [ ] **Run the full test suite**

Run: `npm test`
Expected: all tests pass (note: DB-backed suites like `oauth.test.ts` require the test database per `npm run test:prepare`; the new `channel-link.test.ts` needs no DB).

- [ ] **Typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all clean.

---

## Operational follow-up (outside this plan, document in PR description)

1. Add the `Channel.ReadBasic.All` **delegated** permission to the "HAVEN Hub Mailer" Entra app registration; grant **admin consent** (this scope requires it).
2. Have an admin re-connect the mailbox at `/admin/email` so the stored refresh token carries the new scope.
3. Ensure `hfc.it@yale.edu` is a **member** of the clinic Team.
4. Set `TEAMS_CLINIC_GROUP_ID` in the deployment environment to the clinic Team's groupId.
