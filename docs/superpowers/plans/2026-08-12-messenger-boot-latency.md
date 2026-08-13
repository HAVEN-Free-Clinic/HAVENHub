# Messenger Boot Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the support launcher appear as soon as the page hydrates, instead of after a round trip and two database queries.

**Architecture:** The token mint moves out of the route body into one shared function returning a discriminated result. The `(app)` layout calls it in its existing `Promise.all` and passes the token to `IntercomMessenger` as an optional prop; the route keeps its exact HTTP contract and remains what the refresh loop calls. The component boots from the prop when present and falls back to fetching when it is not, and renders preconnect hints so the widget script meets a warm connection.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Prisma, `@intercom/messenger-js-sdk`, Vitest.

Spec: `docs/superpowers/specs/2026-08-12-messenger-boot-latency-design.md`

## Global Constraints

- **No em-dash (U+2014) anywhere in `src/**/*.{ts,tsx}`.** CI-enforced via `local/no-em-dash`.
- **Never call `Date.now()` or `Math.random()` in a Server Component body.** The `react-hooks/purity` rule (supplied by `eslint-config-next`, not declared in `eslint.config.mjs`) flags them, including in async Server Components. `new Date()` is fine. Nothing in this plan needs either, but do not introduce one.
- **The route's HTTP contract must not change.** Same status codes, same bodies, same `Cache-Control: no-store`. Its existing tests must pass completely unedited; needing to edit one means the refactor changed behavior.
- **`initialToken` is optional and nullable.** Never make it required. Downstream `feat/support-ui` mounts this component on surfaces that legitimately have no token at all.
- **Do NOT add a `requireActiveMembership` parameter.** That gate does not exist on this branch. See the spec's membership-gate note.
- **No `tailwind-merge`.** Use `cx` from `@/platform/ui/cx` if composing classes.
- **DOM tests** need `// @vitest-environment jsdom` on line 1, bare `createRoot` + `act()`, and must NOT use `@testing-library/react` (not a dependency).
- **Never pipe a test run through `tail` and trust the exit code.** Read the pass/fail counts.
- **Test DB for this worktree:** `TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate"`. Storage tests also need `BLOB_READ_WRITE_TOKEN=""`.
- **Check `ps aux | grep vitest` before any run.** Peer sessions work in sibling worktrees. Their databases differ, but `UPLOAD_DIR` is one hardcoded `/tmp` path shared across every worktree, so storage-touching tests can still collide. Concurrent runs have produced false regression alarms in this repo repeatedly.

---

### Task 1: Extract the mint into a shared function

Pure refactor. The route's observable behavior must not change at all.

**Files:**
- Create: `src/platform/intercom/mint-token.ts`
- Test: `src/platform/intercom/mint-token.test.ts`
- Modify: `src/app/api/support/messenger-token/route.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  type MintResult =
    | { ok: true; token: string; expiresInSeconds: number }
    | { ok: false; reason: "not_configured" | "unauthorized" | "db_unreachable" };

  mintMessengerTokenForSession(): Promise<MintResult>
  ```

- [ ] **Step 1: Write the failing test**

Create `src/platform/intercom/mint-token.test.ts`. The function reads the session and the database, so both are mocked; this test is about the decision table, not about auth internals.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getActivePerson: vi.fn(),
  getEffectivePermissions: vi.fn(),
  isIntercomConfigured: vi.fn(),
  mintIntercomUserJwt: vi.fn(),
  isDbUnreachableError: vi.fn(),
}));

vi.mock("@/platform/auth/auth", () => ({ auth: mocks.auth }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: mocks.getActivePerson }));
vi.mock("@/platform/rbac/engine", () => ({ getEffectivePermissions: mocks.getEffectivePermissions }));
vi.mock("@/platform/intercom/config", () => ({ isIntercomConfigured: mocks.isIntercomConfigured }));
vi.mock("@/platform/intercom/jwt", () => ({
  mintIntercomUserJwt: mocks.mintIntercomUserJwt,
  INTERCOM_TOKEN_TTL_SECONDS: 900,
}));
vi.mock("@/platform/db", () => ({ isDbUnreachableError: mocks.isDbUnreachableError }));

import { mintMessengerTokenForSession } from "./mint-token";

const PERSON = { id: "person-1", name: "Test Person", contactEmail: "t@example.com" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isIntercomConfigured.mockReturnValue(true);
  mocks.auth.mockResolvedValue({ personId: PERSON.id });
  mocks.getActivePerson.mockResolvedValue(PERSON);
  mocks.getEffectivePermissions.mockResolvedValue([]);
  mocks.mintIntercomUserJwt.mockResolvedValue("signed.jwt.value");
  mocks.isDbUnreachableError.mockReturnValue(false);
});

describe("mintMessengerTokenForSession", () => {
  it("mints a token and reports the real TTL", async () => {
    const result = await mintMessengerTokenForSession();
    expect(result).toEqual({ ok: true, token: "signed.jwt.value", expiresInSeconds: 900 });
  });

  it("reports not_configured when the integration is off, without touching the session", async () => {
    mocks.isIntercomConfigured.mockReturnValue(false);
    const result = await mintMessengerTokenForSession();
    expect(result).toEqual({ ok: false, reason: "not_configured" });
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("reports unauthorized when there is no session", async () => {
    mocks.auth.mockResolvedValue(null);
    expect(await mintMessengerTokenForSession()).toEqual({ ok: false, reason: "unauthorized" });
  });

  // This is the offboarding revocation check: a member who has been offboarded
  // must stop getting tokens even while their hub JWT is still valid.
  it("reports unauthorized when the session resolves to no active person", async () => {
    mocks.getActivePerson.mockResolvedValue(null);
    expect(await mintMessengerTokenForSession()).toEqual({ ok: false, reason: "unauthorized" });
    expect(mocks.mintIntercomUserJwt).not.toHaveBeenCalled();
  });

  // A database blip must never resolve as "still active", which would hand a
  // token to someone whose revocation we could not check.
  it("reports db_unreachable rather than minting when the database is down", async () => {
    const boom = new Error("connection refused");
    mocks.getActivePerson.mockRejectedValue(boom);
    mocks.isDbUnreachableError.mockReturnValue(true);
    expect(await mintMessengerTokenForSession()).toEqual({ ok: false, reason: "db_unreachable" });
    expect(mocks.mintIntercomUserJwt).not.toHaveBeenCalled();
  });

  it("rethrows an unexpected error instead of swallowing it as a clean refusal", async () => {
    mocks.getActivePerson.mockRejectedValue(new Error("programmer error"));
    mocks.isDbUnreachableError.mockReturnValue(false);
    await expect(mintMessengerTokenForSession()).rejects.toThrow("programmer error");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate" npx vitest run src/platform/intercom/mint-token.test.ts
```
Expected: FAIL, cannot resolve `./mint-token`.

- [ ] **Step 3: Write the shared function**

Create `src/platform/intercom/mint-token.ts`. Move the logic out of the route verbatim; do not redesign it.

```ts
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { isDbUnreachableError } from "@/platform/db";
import { isIntercomConfigured } from "@/platform/intercom/config";
import { mintIntercomUserJwt, INTERCOM_TOKEN_TTL_SECONDS } from "@/platform/intercom/jwt";
import { buildAudienceAttributes } from "@/platform/intercom/audience";

/**
 * Why a discriminated result rather than `string | null`: each refusal means
 * something specific, and both callers need to tell them apart.
 *
 *   not_configured  the integration is off, so the route 404s (looking absent
 *                   rather than half-configured) and the layout mints nothing
 *   unauthorized    no session, OR a session resolving to no active Person.
 *                   That second case IS the offboarding revocation check: an
 *                   offboarded member must stop getting tokens while their hub
 *                   JWT is still valid
 *   db_unreachable  we could not run the revocation check, so we refuse rather
 *                   than resolving as "still active"
 *
 * Collapsing these to null would force each caller to re-derive them, or to
 * skip them silently. Adding an outcome later (a membership gate, say) is a new
 * variant rather than a change to the existing ones.
 */
export type MintResult =
  | { ok: true; token: string; expiresInSeconds: number }
  | { ok: false; reason: "not_configured" | "unauthorized" | "db_unreachable" };

/**
 * Mints the signed-in person's Intercom identity-verification JWT.
 *
 * Every claim comes from the server session and the live Person row; nothing is
 * taken from a request body or query. Shared by the token route and the server
 * render of the (app) layout so a first token and a refreshed token can never
 * drift apart in claims or TTL.
 */
export async function mintMessengerTokenForSession(): Promise<MintResult> {
  if (!isIntercomConfigured()) return { ok: false, reason: "not_configured" };

  const session = await auth();
  if (!session?.personId) return { ok: false, reason: "unauthorized" };

  try {
    const person = await getActivePerson(session.personId);
    if (!person) return { ok: false, reason: "unauthorized" };

    // Audience flags ride on the token rather than being pushed to Intercom by
    // a separate sync job, so they are recomputed from live permissions on
    // every mint and cannot drift into a stale copy.
    const perms = await getEffectivePermissions(person.id);

    const token = await mintIntercomUserJwt({
      personId: person.id,
      name: person.name,
      email: person.contactEmail ?? null,
      audience: buildAudienceAttributes(perms),
    });

    return { ok: true, token, expiresInSeconds: INTERCOM_TOKEN_TTL_SECONDS };
  } catch (err) {
    if (isDbUnreachableError(err)) return { ok: false, reason: "db_unreachable" };
    throw err;
  }
}
```

- [ ] **Step 4: Rewrite the route as a thin mapping**

Replace the body of `GET()` in `src/app/api/support/messenger-token/route.ts` so it only maps the result to HTTP. Keep the file's existing doc comment except for the correction in Step 5.

```ts
export async function GET(): Promise<Response> {
  const result = await mintMessengerTokenForSession();

  if (!result.ok) {
    switch (result.reason) {
      // Feature off looks like the route does not exist, rather than
      // advertising a half-configured integration.
      case "not_configured":
        return Response.json({ error: "Not Found" }, { status: 404 });
      case "unauthorized":
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      case "db_unreachable":
        log.warn("[intercom] database unreachable minting messenger token");
        return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
  }

  return Response.json(
    { token: result.token, expiresInSeconds: result.expiresInSeconds },
    // A bearer token must never sit in a shared or browser cache.
    { headers: { "Cache-Control": "no-store" } }
  );
}
```

Remove imports the route no longer uses (`auth`, `getActivePerson`, `getEffectivePermissions`, `mintIntercomUserJwt`, `buildAudienceAttributes`, `isIntercomConfigured`, `isDbUnreachableError`, `errorAttrs`) and add `mintMessengerTokenForSession`. Keep `log` for the 503 warning. Leave `export const runtime` and `export const dynamic` untouched.

Note the 503 log loses its `errorAttrs(err)` payload, because the error no longer crosses the boundary. If you would rather keep the attributes, have `MintResult` carry the error on the `db_unreachable` variant. Either is acceptable; do not silently drop the log line itself.

- [ ] **Step 5: Correct the route's doc comment**

The comment currently says minting lives in a route handler because "the lint purity rule keeps [the wall clock] out of render". That is now both untrue and contradicted by the code. Replace that sentence, keeping the second reason, which is real:

```
 * Minting is shared with the (app) layout's server render (see
 * ./mint-token), which is what removes the token round trip from the
 * launcher's critical path. This route remains the endpoint a long-lived tab
 * calls for a fresh token, instead of booting once with one that silently dies
 * mid-session.
```

- [ ] **Step 6: Run the route's existing tests, unedited**

This is the real proof the refactor preserved the contract.

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate" npx vitest run src/app/api/support/messenger-token/route.test.ts src/platform/intercom/mint-token.test.ts
```
Expected: all route tests pass with NO edits to that file, plus 6 new tests. If a route test needs changing to pass, stop: the refactor changed behavior and that is a defect, not a test to update.

- [ ] **Step 7: Commit**

```bash
git add src/platform/intercom/mint-token.ts src/platform/intercom/mint-token.test.ts src/app/api/support/messenger-token/route.ts
git commit -m "refactor(support): share the Messenger token mint

The (app) layout needs to mint the same token during its server render, and two
implementations would let a first token and a refreshed token drift apart in
claims or TTL.

A discriminated result rather than string-or-null, because each refusal means
something: unauthorized carries the offboarding revocation check, and
db_unreachable exists so a database blip cannot resolve as still active. The
route's HTTP contract is unchanged and its tests pass unedited."
```

---

### Task 2: Boot from a server-minted token

**Files:**
- Modify: `src/platform/intercom/messenger.tsx`
- Modify: `src/app/(app)/layout.tsx`
- Test: `src/platform/intercom/messenger.test.tsx`

**Interfaces:**
- Consumes: `mintMessengerTokenForSession` and `MintResult` from Task 1.
- Produces: `IntercomMessenger({ appId, initialToken }: { appId: string; initialToken?: { token: string; expiresInSeconds: number } | null })`

- [ ] **Step 1: Write the failing test**

Create `src/platform/intercom/messenger.test.tsx`:

```tsx
// @vitest-environment jsdom
/**
 * The SDK is mocked so these assert on WHICH SDK call happens. That distinction
 * is the point: `update` hands over a new token without tearing down an open
 * conversation, and a second `Intercom()` re-boots the widget underneath a
 * member who may be mid-conversation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sdk = vi.hoisted(() => ({ boot: vi.fn(), update: vi.fn(), shutdown: vi.fn() }));
vi.mock("@intercom/messenger-js-sdk", () => ({
  default: sdk.boot,
  update: sdk.update,
  shutdown: sdk.shutdown,
}));

import { IntercomMessenger } from "./messenger";

let mounted: { container: HTMLDivElement; root: Root } | null = null;

async function mount(initialToken?: { token: string; expiresInSeconds: number } | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<IntercomMessenger appId="abc123" initialToken={initialToken} />);
  });
  mounted = { container, root };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
  vi.unstubAllGlobals();
});

describe("IntercomMessenger", () => {
  it("boots immediately from a server-minted token, without fetching", async () => {
    await mount({ token: "server.jwt", expiresInSeconds: 900 });

    expect(sdk.boot).toHaveBeenCalledWith({ app_id: "abc123", intercom_user_jwt: "server.jwt" });
    // The whole point of the change: no round trip on the critical path.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("falls back to fetching when no token was server-minted", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "fetched.jwt", expiresInSeconds: 900 }),
    });

    await mount(null);

    expect(globalThis.fetch).toHaveBeenCalled();
    expect(sdk.boot).toHaveBeenCalledWith({ app_id: "abc123", intercom_user_jwt: "fetched.jwt" });
  });

  /**
   * The regression this guards: booting from the prop without setting `booted`
   * makes the first refresh call Intercom() again instead of update(), which
   * re-boots the widget under a member who may be mid-conversation. Nothing
   * throws, so only asserting on which SDK function ran can catch it.
   */
  it("refreshes with update, not a second boot, after starting from the prop", async () => {
    vi.useFakeTimers();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "refreshed.jwt", expiresInSeconds: 900 }),
    });

    await mount({ token: "server.jwt", expiresInSeconds: 900 });
    expect(sdk.boot).toHaveBeenCalledTimes(1);

    // Advance past the scheduled refresh (TTL minus the 5 minute margin).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(601 * 1000);
    });

    expect(sdk.update).toHaveBeenCalledWith({ intercom_user_jwt: "refreshed.jwt" });
    expect(sdk.boot).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("renders preconnect hints for the Intercom hosts", async () => {
    await mount({ token: "server.jwt", expiresInSeconds: 900 });
    const hrefs = Array.from(document.querySelectorAll('link[rel="preconnect"]')).map((l) =>
      l.getAttribute("href")
    );
    expect(hrefs).toContain("https://widget.intercom.io");
    expect(hrefs).toContain("https://js.intercomcdn.com");
  });
});
```

If React 19's `<link>` hoisting does not place the tags where `document.querySelector` finds them under jsdom, assert on the rendered output another way rather than deleting the case; the preconnect is a deliberate part of this change and should be covered.

- [ ] **Step 2: Run the test to verify it fails**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate" npx vitest run src/platform/intercom/messenger.test.tsx
```
Expected: FAIL. `initialToken` is not a prop yet, so the first case fetches instead of booting.

- [ ] **Step 3: Accept and use the prop**

In `src/platform/intercom/messenger.tsx`, change the signature and the effect. The full effect after the change:

```tsx
export function IntercomMessenger({
  appId,
  initialToken,
}: {
  appId: string;
  /**
   * Minted during the server render so the widget script can start loading the
   * moment React hydrates, instead of after a round trip and the token route's
   * database queries.
   *
   * Optional and nullable on purpose: a server mint legitimately returns
   * nothing when the integration is off, the session resolves to no active
   * Person, or the database is briefly unreachable. In each case this falls
   * back to fetching rather than receiving a fabricated token.
   */
  initialToken?: { token: string; expiresInSeconds: number } | null;
}) {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let booted = false;

    const scheduleIn = (seconds: number) => {
      if (cancelled) return;
      timer = setTimeout(() => void load(), seconds * 1000);
    };

    /** Boot once, then hand over later tokens with `update`. */
    const applyToken = (token: string) => {
      if (booted) {
        update({ intercom_user_jwt: token });
        return;
      }
      Intercom({ app_id: appId, intercom_user_jwt: token });
      booted = true;
    };

    async function load(): Promise<void> {
      if (cancelled) return;

      let token: string | undefined;
      let ttl = INTERCOM_FALLBACK_TTL_SECONDS;
      try {
        const res = await fetch(MESSENGER_TOKEN_PATH, { cache: "no-store" });
        if (!res.ok) {
          // 404 means the integration is switched off server-side, so there is
          // nothing to wait for. Anything else (401 mid-session, 503 DB blip)
          // is transient and worth another try.
          if (res.status !== 404) scheduleIn(RETRY_DELAY_SECONDS);
          return;
        }
        const payload = await res.json();
        token = typeof payload?.token === "string" ? payload.token : undefined;
        if (Number.isFinite(payload?.expiresInSeconds)) ttl = payload.expiresInSeconds;
      } catch {
        scheduleIn(RETRY_DELAY_SECONDS);
        return;
      }

      if (cancelled || !token) {
        if (!cancelled) scheduleIn(RETRY_DELAY_SECONDS);
        return;
      }

      applyToken(token);
      scheduleIn(Math.max(ttl - REFRESH_MARGIN_SECONDS, RETRY_DELAY_SECONDS));
    }

    if (initialToken) {
      // The fast path. applyToken sets `booted`, so the refresh below goes
      // through `update` and does not re-boot the widget under an open
      // conversation.
      applyToken(initialToken.token);
      scheduleIn(
        Math.max(initialToken.expiresInSeconds - REFRESH_MARGIN_SECONDS, RETRY_DELAY_SECONDS)
      );
    } else {
      void load();
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      // Clear the Intercom session and its cookies on unmount. Without this a
      // sign-out (or switching accounts in the same browser) would leave the
      // previous member's support session live for the next person.
      shutdown();
    };
    // Depend on the token STRING, not the object. The prop is deserialized
    // fresh across the RSC boundary, so an object dependency would have a new
    // identity on every render and could re-run this effect, whose cleanup
    // calls shutdown() and would tear down a live conversation.
  }, [appId, initialToken?.token]);

  return (
    <>
      {/* Rendered here rather than in a layout so every surface that mounts the
          Messenger gets them. React hoists these into <head>. They cut DNS and
          the TLS handshake off the widget script's critical path. */}
      <link rel="preconnect" href="https://widget.intercom.io" />
      <link rel="preconnect" href="https://js.intercomcdn.com" crossOrigin="anonymous" />
    </>
  );
}
```

The dependency is `initialToken?.token`, the string, deliberately not the object. This is the hazard it avoids: the prop crosses the RSC boundary and is deserialized fresh, so an object dependency has a new identity on every render. Re-running this effect runs its cleanup, and that cleanup calls `shutdown()`, which would tear down a live support conversation. `react-hooks/exhaustive-deps` may want the whole object; the narrower dependency is correct here, so if the rule complains, add a targeted disable with that reason rather than widening it back.

- [ ] **Step 4: Run the test to verify it passes**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate" npx vitest run src/platform/intercom/messenger.test.tsx
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Mint in the layout**

In `src/app/(app)/layout.tsx`, add the import:

```tsx
import { mintMessengerTokenForSession } from "@/platform/intercom/mint-token";
```

Add it to the existing `Promise.all` so it parallelizes with the queries already running there:

```tsx
  const [activeTerm, scope, isPanelist, supportContact, blockerGateEnabled, messengerToken] =
    await Promise.all([
      getActiveTerm(),
      reviewScope(person.personId),
      isInterviewPanelist(person.personId),
      getSupportContact(),
      getSetting<boolean>("support.blockerGateEnabled"),
      mintMessengerTokenForSession(),
    ]);
```

Then pass it, keeping the existing `supportAppId` guard exactly as it is:

```tsx
      {supportAppId ? (
        <IntercomMessenger
          appId={supportAppId}
          initialToken={messengerToken.ok ? messengerToken : null}
        />
      ) : null}
```

`messengerToken.ok ? messengerToken : null` narrows to the success variant, which already carries `token` and `expiresInSeconds`. A refusal passes null and the component falls back to fetching, which is exactly today's behavior.

- [ ] **Step 6: Verify**

```bash
npm run typecheck
npx eslint src e2e
```
Expected: typecheck clean. Lint 0 errors, with 2 pre-existing `<img>` warnings in untouched files.

Lint matters more than usual here: the spec's claim that `react-hooks/purity` will not fire on this design is reasoning, and reasoning is what produced the wrong comment this plan removes. If it does fire, do NOT hoist a `Date.now()` anywhere; report it, because it would mean the design needs revisiting.

Then, with nothing else running (`ps aux | grep vitest`):

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate" BLOB_READ_WRITE_TOKEN="" npm test
```
Expected: no failures. Compare against the branch's last known-good run rather than assuming; if you see unique-constraint, foreign-key, or deadlock failures, that is cross-worktree contention, not a regression. Confirm no other vitest is running and re-run.

- [ ] **Step 7: Commit**

```bash
git add src/platform/intercom/messenger.tsx "src/app/(app)/layout.tsx" src/platform/intercom/messenger.test.tsx
git commit -m "perf(support): boot the Messenger from a server-minted token

The launcher could not appear until a fully serial chain finished: hydrate,
round trip to the token route, that route's two database queries, and only then
inject the widget script. The layout already runs server queries, so it mints
the first token in the same Promise.all and hands it over as a prop. The widget
script now starts downloading the moment React hydrates.

Booting from the prop sets `booted`, so the first refresh calls update rather
than re-booting the widget under an open conversation. The fetch loop stays: it
is what a long-lived tab uses for a fresh token. Preconnect hints render from
the component so they cover every surface that mounts it."
```

---

## Notes for the implementer

- **Do not change the route's HTTP contract.** Its status codes are load-bearing: 404 hides a half-configured integration, 401 is the offboarding revocation check, 503 stops a database blip resolving as "still active". Its tests passing unedited is the proof.
- **Do not make `initialToken` required.** Downstream `feat/support-ui` mounts this component on public surfaces that legitimately have no token.
- **Do not add a `requireActiveMembership` parameter.** No such gate exists on this branch, so it would be a dead argument. The hazard is recorded in the spec for whoever owns the gate.
- **Do not boot anonymously and upgrade later.** It would be faster and it creates an unverified Intercom session first, which is the impersonation hole identity verification exists to close.
- **`shutdown()` on unmount must stay.** Without it, signing out leaves the previous member's support session live for the next person in the same browser.
