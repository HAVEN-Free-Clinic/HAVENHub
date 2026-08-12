# Content Blocker Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block the authenticated hub with an undismissable modal when a content blocker is breaking the Intercom Messenger, so no member is silently left without a way to reach support.

**Architecture:** A dependency-injected pure probe (`blocker-probe.ts`) decides whether a blocker is breaking either half of the Messenger, and a client component (`blocker-gate.tsx`) renders the gate and handles re-checking. Both mount from the `(app)` layout under the existing `supportAppId` guard, so the gate is inert wherever Intercom is unconfigured (local dev, CI, e2e, preview, demo).

**Tech Stack:** Next.js App Router, React 19, TypeScript, Vitest (jsdom for DOM tests), posthog-js, Tailwind.

Spec: `docs/superpowers/specs/2026-08-11-content-blocker-gate-design.md`

## Global Constraints

- **No em-dash (U+2014) anywhere in `src/**/*.{ts,tsx}`.** CI-enforced via `local/no-em-dash`. Use a comma, colon, parentheses, or hyphen.
- **No `tailwind-merge`.** Use `cx` from `@/platform/ui/cx` to compose class names.
- **Component tests use bare `createRoot` + `act()`, never testing-library** (it is not a dependency). DOM tests need the `// @vitest-environment jsdom` docblock on line 1.
- **Run the full lint before pushing:** `npx eslint src e2e`. Bare `eslint .` walks a gitignored design-system directory and fails spuriously.
- **Tests need a per-worktree database.** This worktree uses `TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate"`. Storage tests additionally need `BLOB_READ_WRITE_TOKEN=""`.
- **Never pipe a test run through `tail` and trust the exit code.** A piped run returns 0 even when the suite fails. Read the pass/fail counts.
- **Apostrophes in JSX text** trip `react/no-unescaped-entities`. Write such copy as a JS string expression, e.g. `{"I've turned it off"}`.

---

### Task 1: The detection probe

**Files:**
- Create: `src/platform/intercom/blocker-probe.ts`
- Test: `src/platform/intercom/blocker-probe.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type BlockedProbe = "token" | "widget"`
  - `type ProbeResult = { blocked: false } | { blocked: true; failed: BlockedProbe[] }`
  - `type ProbeDeps = { fetch: typeof globalThis.fetch; onLine: () => boolean; delay: (ms: number) => Promise<void> }`
  - `probeContentBlocker(appId: string, deps: ProbeDeps): Promise<ProbeResult>`
  - `browserProbeDeps(): ProbeDeps`
  - Constants `CONTROL_URL`, `TOKEN_URL`, `RETRY_DELAY_MS`, and `widgetUrl(appId: string): string`

- [ ] **Step 1: Write the failing tests**

Create `src/platform/intercom/blocker-probe.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  probeContentBlocker,
  CONTROL_URL,
  TOKEN_URL,
  type ProbeDeps,
} from "./blocker-probe";

const APP_ID = "abc123";

/**
 * Maps a URL substring to an outcome: a status number resolves with that
 * status, "reject" throws the way a blocked request does. Anything unmatched
 * resolves 200.
 */
function stub(map: Record<string, number | "reject">) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(map).find((k) => url.includes(k));
    const outcome = key ? map[key] : 200;
    if (outcome === "reject") throw new TypeError("Failed to fetch");
    return new Response(null, { status: outcome });
  });
}

function deps(fetchImpl: ReturnType<typeof stub>, onLine = true): ProbeDeps {
  // delay resolves immediately: the retry timing is not what these assert.
  return { fetch: fetchImpl as unknown as typeof globalThis.fetch, onLine: () => onLine, delay: async () => {} };
}

describe("probeContentBlocker", () => {
  it("does not gate when the control probe is unreachable, because that is a network fault", async () => {
    // Everything fails, which is what being offline mid-flight looks like.
    const result = await probeContentBlocker(APP_ID, deps(stub({ "haven-mark": "reject", "messenger-token": "reject", "widget.intercom.io": "reject" })));
    expect(result).toEqual({ blocked: false });
  });

  it("does not gate when the token route 404s, because the integration is switched off", async () => {
    const result = await probeContentBlocker(APP_ID, deps(stub({ "messenger-token": 404 })));
    expect(result).toEqual({ blocked: false });
  });

  it("does not gate on a 401, because a response proves the request left the browser", async () => {
    const result = await probeContentBlocker(APP_ID, deps(stub({ "messenger-token": 401 })));
    expect(result).toEqual({ blocked: false });
  });

  it("does not gate on a 503, because a server outage is not a content blocker", async () => {
    const result = await probeContentBlocker(APP_ID, deps(stub({ "messenger-token": 503 })));
    expect(result).toEqual({ blocked: false });
  });

  it("gates when the token route is blocked but the control gets through", async () => {
    const result = await probeContentBlocker(APP_ID, deps(stub({ "messenger-token": "reject" })));
    expect(result).toEqual({ blocked: true, failed: ["token"] });
  });

  it("gates when the Messenger widget host is blocked", async () => {
    const result = await probeContentBlocker(APP_ID, deps(stub({ "widget.intercom.io": "reject" })));
    expect(result).toEqual({ blocked: true, failed: ["widget"] });
  });

  it("reports both halves when both are blocked", async () => {
    const result = await probeContentBlocker(APP_ID, deps(stub({ "messenger-token": "reject", "widget.intercom.io": "reject" })));
    expect(result).toEqual({ blocked: true, failed: ["token", "widget"] });
  });

  it("does not gate when a single rejection clears on the retry", async () => {
    let tokenCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("messenger-token")) {
        tokenCalls += 1;
        if (tokenCalls === 1) throw new TypeError("Failed to fetch");
      }
      return new Response(null, { status: 200 });
    });
    const result = await probeContentBlocker(APP_ID, deps(fetchImpl as ReturnType<typeof stub>));
    expect(result).toEqual({ blocked: false });
    expect(tokenCalls).toBe(2);
  });

  it("does not gate when the network drops between the first attempt and the retry", async () => {
    let controlCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("haven-mark")) {
        controlCalls += 1;
        // Reachable first time round, gone by the retry.
        if (controlCalls > 1) throw new TypeError("Failed to fetch");
        return new Response(null, { status: 200 });
      }
      if (url.includes("messenger-token")) throw new TypeError("Failed to fetch");
      return new Response(null, { status: 200 });
    });
    const result = await probeContentBlocker(APP_ID, deps(fetchImpl as ReturnType<typeof stub>));
    expect(result).toEqual({ blocked: false });
  });

  it("does not probe at all when the browser reports it is offline", async () => {
    const fetchImpl = stub({});
    const result = await probeContentBlocker(APP_ID, deps(fetchImpl, false));
    expect(result).toEqual({ blocked: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requests the control and token URLs it documents", async () => {
    const fetchImpl = stub({});
    await probeContentBlocker(APP_ID, deps(fetchImpl));
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain(CONTROL_URL);
    expect(urls).toContain(TOKEN_URL);
    expect(urls.some((u) => u.includes(APP_ID))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate" npx vitest run src/platform/intercom/blocker-probe.test.ts
```
Expected: FAIL, cannot resolve `./blocker-probe`.

- [ ] **Step 3: Write the implementation**

Create `src/platform/intercom/blocker-probe.ts`:

```ts
/**
 * Detects whether a content blocker is breaking the Intercom Messenger.
 *
 * Deliberately narrow: this does NOT detect content blockers in general. It
 * probes the two things that actually break support, so a blocker that breaks
 * nothing the member can see never gates anyone. Bait requests and cosmetic
 * filter bait are explicitly not used. See
 * docs/superpowers/specs/2026-08-11-content-blocker-gate-design.md.
 *
 * Dependency-injected and free of window/document/globals, so the decision
 * rule is testable without a DOM.
 */

/** Which half of the Messenger a blocker killed. */
export type BlockedProbe = "token" | "widget";

export type ProbeResult =
  | { blocked: false }
  | { blocked: true; failed: BlockedProbe[] };

export type ProbeDeps = {
  fetch: typeof globalThis.fetch;
  /** navigator.onLine, injected so the offline guard is testable. */
  onLine: () => boolean;
  delay: (ms: number) => Promise<void>;
};

/**
 * A static asset, deliberately not an API route. It proves the network works
 * at all, so an offline laptop, a Neon blip, or a Vercel hiccup cannot
 * masquerade as a blocker. This guard is what makes a gate with no dismissal
 * defensible.
 *
 * Two properties matter. It sits on a different path prefix from the token
 * route, so one filter rule cannot fail both and silently stand the gate down.
 * And if the asset is ever renamed or deleted it returns 404, which RESOLVES,
 * so the control still passes: a rename cannot quietly disable the gate the
 * way a deleted purpose-built route would.
 */
export const CONTROL_URL = "/brand/haven-mark.svg";

/** Must stay in sync with MESSENGER_TOKEN_PATH in ./messenger. */
export const TOKEN_URL = "/api/support/messenger-token";

/** The Messenger's own script host, which EasyPrivacy blocks by default. */
export function widgetUrl(appId: string): string {
  return `https://widget.intercom.io/widget/${appId}`;
}

/** Long enough to clear a momentary fault, short enough not to strand a blocked member. */
export const RETRY_DELAY_MS = 2000;

/**
 * `reached: true` means a response came back, whatever its status. Only a
 * rejected promise (ERR_BLOCKED_BY_CLIENT, a DNS failure, offline) is a
 * candidate block.
 */
type Outcome = { reached: true; status: number } | { reached: false };

async function attempt(deps: ProbeDeps, url: string, init: RequestInit = {}): Promise<Outcome> {
  try {
    // cache last so a caller's init cannot accidentally reintroduce caching:
    // a cached 200 from before the blocker was installed would hide it.
    const res = await deps.fetch(url, { ...init, cache: "no-store" });
    return { reached: true, status: res.status };
  } catch {
    return { reached: false };
  }
}

const NOT_BLOCKED: ProbeResult = { blocked: false };

export async function probeContentBlocker(appId: string, deps: ProbeDeps): Promise<ProbeResult> {
  if (!deps.onLine()) return NOT_BLOCKED;

  const [control, token, widget] = await Promise.all([
    attempt(deps, CONTROL_URL),
    attempt(deps, TOKEN_URL),
    attempt(deps, widgetUrl(appId), { mode: "no-cors" }),
  ]);

  // The network or the server is at fault, not a blocker.
  if (!control.reached) return NOT_BLOCKED;

  // The integration is switched off server-side, so there is nothing to
  // protect. This is the rule messenger.tsx already applies to the same status.
  if (token.reached && token.status === 404) return NOT_BLOCKED;

  const suspects: BlockedProbe[] = [];
  if (!token.reached) suspects.push("token");
  if (!widget.reached) suspects.push("widget");
  if (suspects.length === 0) return NOT_BLOCKED;

  await deps.delay(RETRY_DELAY_MS);

  // Re-check the control as well. If the network dropped between the two
  // attempts, both probes would reject and we would gate on a network fault,
  // which is the false positive this whole design exists to avoid.
  const recheckControl = await attempt(deps, CONTROL_URL);
  if (!recheckControl.reached) return NOT_BLOCKED;

  const failed: BlockedProbe[] = [];
  for (const suspect of suspects) {
    const outcome =
      suspect === "token"
        ? await attempt(deps, TOKEN_URL)
        : await attempt(deps, widgetUrl(appId), { mode: "no-cors" });
    // A 404 on the retry still means the integration is off, and `reached`
    // covers that: only a rejection confirms the block.
    if (!outcome.reached) failed.push(suspect);
  }

  return failed.length > 0 ? { blocked: true, failed } : NOT_BLOCKED;
}

/** The real browser dependencies. */
export function browserProbeDeps(): ProbeDeps {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    onLine: () => navigator.onLine,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate" npx vitest run src/platform/intercom/blocker-probe.test.ts
```
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/platform/intercom/blocker-probe.ts src/platform/intercom/blocker-probe.test.ts
git commit -m "feat(support): detect a content blocker breaking the Messenger

Probes only the two halves that actually break support, never generic
blocker bait: a blocker that breaks nothing visible is not grounds for
gating anyone. A static-asset control probe keeps offline laptops and Neon
blips from masquerading as blockers, and it is re-checked on the retry so a
mid-flight network drop cannot gate either."
```

---

### Task 2: The gate component

**Files:**
- Create: `src/platform/intercom/blocker-gate.tsx`
- Test: `src/platform/intercom/blocker-gate.test.tsx`

**Interfaces:**
- Consumes: `probeContentBlocker`, `browserProbeDeps`, `BlockedProbe` from Task 1.
- Produces: `BlockerGate({ appId, supportEmail }: { appId: string; supportEmail: string })`, a client component rendering `null` when not gated.

- [ ] **Step 1: Write the failing tests**

Create `src/platform/intercom/blocker-gate.test.tsx`:

```tsx
// @vitest-environment jsdom
/**
 * Mounts BlockerGate with the probe stubbed, following flash-reader.test.tsx's
 * approach: a bare createRoot + act() mount, no testing-library. The probe's
 * own decision rule is blocker-probe.test.ts's job; this proves the wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ProbeResult } from "./blocker-probe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let probeResult: ProbeResult = { blocked: false };
const probeCalls = { count: 0 };

vi.mock("./blocker-probe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./blocker-probe")>();
  return {
    ...actual,
    probeContentBlocker: vi.fn(async () => {
      probeCalls.count += 1;
      return probeResult;
    }),
  };
});

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));

// Static import is safe and matches flash-reader.test.tsx: vitest hoists
// vi.mock above every import, so the mock is registered before this resolves.
import { BlockerGate } from "./blocker-gate";

let mounted: { container: HTMLDivElement; root: Root } | null = null;

async function mount(supportEmail = "help@example.org") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<BlockerGate appId="abc123" supportEmail={supportEmail} />);
  });
  mounted = { container, root };
}

beforeEach(() => {
  probeResult = { blocked: false };
  probeCalls.count = 0;
});

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
  document.body.style.overflow = "";
});

describe("BlockerGate", () => {
  it("renders nothing when no blocker is breaking the Messenger", async () => {
    await mount();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders a modal dialog when a blocker is detected", async () => {
    probeResult = { blocked: true, failed: ["widget"] };
    await mount();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
  });

  it("offers no way to dismiss it, because the whole point is that it blocks", async () => {
    probeResult = { blocked: true, failed: ["widget"] };
    await mount();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('[aria-label="Close"]')).toBeNull();
    // Escape must not clear it either.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("locks body scroll while it is up, so the page behind cannot be used", async () => {
    probeResult = { blocked: true, failed: ["token"] };
    await mount();
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("clears itself when a re-check finds the blocker gone", async () => {
    probeResult = { blocked: true, failed: ["token"] };
    await mount();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    probeResult = { blocked: false };
    const button = document.querySelector<HTMLButtonElement>('[data-testid="blocker-recheck"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("stays up when a re-check still finds the blocker", async () => {
    probeResult = { blocked: true, failed: ["token"] };
    await mount();
    const button = document.querySelector<HTMLButtonElement>('[data-testid="blocker-recheck"]');
    await act(async () => {
      button?.click();
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("offers a mailto escape for anyone who cannot turn their blocker off", async () => {
    probeResult = { blocked: true, failed: ["widget"] };
    await mount("help@example.org");
    const link = document.querySelector('a[href^="mailto:"]');
    expect(link?.getAttribute("href")).toBe("mailto:help@example.org");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate" npx vitest run src/platform/intercom/blocker-gate.test.tsx
```
Expected: FAIL, cannot resolve `./blocker-gate`.

- [ ] **Step 3: Write the implementation**

Create `src/platform/intercom/blocker-gate.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ShieldAlert } from "lucide-react";
import posthog from "posthog-js";
import { SupportLink } from "@/platform/branding/support-link";
import { browserProbeDeps, probeContentBlocker, type BlockedProbe } from "./blocker-probe";

/**
 * Blocks the hub when a content blocker is breaking the Intercom Messenger.
 *
 * There is deliberately no way through. A member whose Messenger is blocked
 * cannot reach support and has no sign anything is wrong, so the gate demands
 * the blocker come off rather than letting them discover it at the moment they
 * need help. The false-positive risk that creates is answered in the probe (see
 * ./blocker-probe), not here: by the time this renders, a blocked request has
 * been confirmed twice against a control probe that proves the network works.
 *
 * Does NOT reuse the Modal primitive. Modal renders an unconditional close
 * button and calls onClose on Escape and backdrop click; a no-op onClose would
 * leave a dead X on screen, which reads as broken exactly when the page most
 * needs to be trusted. The focus trap and scroll lock below are Modal's,
 * borrowed without its dismissal contract.
 */
export function BlockerGate({ appId, supportEmail }: { appId: string; supportEmail: string }) {
  const [failed, setFailed] = useState<BlockedProbe[] | null>(null);
  const [checking, setChecking] = useState(false);
  const settled = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // One probe per full page load. This component lives in the (app) layout, so
  // it survives soft navigation and must not re-probe on every route change.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (settled.current) return;
      // A backgrounded tab throttles fetches, which would read as a block.
      // Defer rather than stand down: opening the hub in a background tab must
      // not buy a free pass, so the listener below picks it up on first view.
      if (document.visibilityState !== "visible") return;
      settled.current = true;
      const result = await probeContentBlocker(appId, browserProbeDeps());
      if (cancelled || !result.blocked) return;
      setFailed(result.failed);
      // /ingest is same-origin proxied, so this usually survives the very
      // blocker that triggered it. It is the only way to learn how often the
      // gate fires and how many people it strands.
      posthog.capture("content_blocker_gate_shown", { probes: result.failed });
    }
    void run();
    document.addEventListener("visibilitychange", run);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", run);
    };
  }, [appId]);

  const recheck = useCallback(async () => {
    setChecking(true);
    const result = await probeContentBlocker(appId, browserProbeDeps());
    setChecking(false);
    if (result.blocked) {
      setFailed(result.failed);
      return;
    }
    setFailed(null);
    posthog.capture("content_blocker_gate_cleared");
  }, [appId]);

  // Turning a blocker off means leaving the tab for the extension menu, so
  // catch them on the way back rather than making them find the button.
  useEffect(() => {
    if (!failed) return;
    function onFocus() {
      void recheck();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [failed, recheck]);

  // Scroll lock and focus trap, mirroring the Modal primitive. No Escape
  // handler on purpose: Escape must do nothing.
  useEffect(() => {
    if (!failed) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      // The browser blurs to <body> whenever the focused control becomes
      // disabled, which the re-check button does while it runs. Pull focus
      // back in before the default runs, or Tab walks into the locked page.
      if (!active || !panelRef.current?.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [failed]);

  if (!failed) return null;

  return createPortal(
    // Above the help bubble and the toast viewport, both of which sit at z-50.
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="glass-panel flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-auto rounded-2xl p-6 outline-none"
      >
        <div className="flex items-start gap-3">
          <ShieldAlert aria-hidden className="mt-0.5 h-6 w-6 shrink-0 text-brand-fg" />
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-foreground">
              Turn off your content blocker to continue
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A content blocker in this browser is blocking HAVEN Hub&apos;s support
              assistant, so you would have no way to reach anyone for help. Turn it off
              for this site to continue.
            </p>
          </div>
        </div>

        <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">Extensions</span> (uBlock Origin,
            AdBlock, Ghostery): click the extension icon in your toolbar, then disable it
            for this site.
          </li>
          <li>
            <span className="font-medium text-foreground">Brave</span>: click the Shields
            icon in the address bar and turn Shields off for this site.
          </li>
          <li>
            <span className="font-medium text-foreground">Safari</span>: turn off content
            blockers for this site in Settings, then reload.
          </li>
          <li>
            <span className="font-medium text-foreground">A managed device or network</span>{" "}
            (a clinic laptop, or a home filter like Pi-hole) may block this where you
            cannot change it yourself. Email us and we will sort it out.
          </li>
        </ul>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <span className="text-xs text-muted-foreground">
            Still stuck?{" "}
            <SupportLink email={supportEmail}>Email the IT team</SupportLink>
          </span>
          <button
            type="button"
            data-testid="blocker-recheck"
            onClick={() => void recheck()}
            disabled={checking}
            className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-60"
          >
            {checking ? "Checking..." : "I've turned it off"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate" npx vitest run src/platform/intercom/blocker-gate.test.tsx
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/platform/intercom/blocker-gate.tsx src/platform/intercom/blocker-gate.test.tsx
git commit -m "feat(support): gate the hub when a blocker breaks the Messenger

No dismissal, because a member who clicks past this discovers the problem
at the moment they need help and cannot report it. It does not reuse Modal:
Modal's close button is unconditional, and a dead X reads as broken exactly
when the page most needs to be trusted.

The mailto is load-bearing rather than decorative. A managed device or a
network-level filter is correctly detected and genuinely cannot comply, so
that link is the only route those members have left."
```

---

### Task 3: Mount the gate

**Files:**
- Modify: `src/app/(app)/layout.tsx`

**Interfaces:**
- Consumes: `BlockerGate` from Task 2, `getSupportContact` from `@/platform/branding/support`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the imports**

In `src/app/(app)/layout.tsx`, alongside the existing `IntercomMessenger` import:

```tsx
import { BlockerGate } from "@/platform/intercom/blocker-gate";
import { getSupportContact } from "@/platform/branding/support";
```

- [ ] **Step 2: Fetch the support contact**

Add `getSupportContact()` to the existing `Promise.all`, so it costs no extra round trip. `getSetting` caches for 30s, so this is effectively free on the render path:

```tsx
const [activeTerm, scope, isPanelist, supportContact] = await Promise.all([
  getActiveTerm(),
  reviewScope(person.personId),
  isInterviewPanelist(person.personId),
  getSupportContact(),
]);
```

- [ ] **Step 3: Render the gate beside the Messenger**

Replace the existing single-line render:

```tsx
{supportAppId ? <IntercomMessenger appId={supportAppId} /> : null}
```

with:

```tsx
{/* Both gated on the same supportAppId, deliberately. The gate exists only to
    protect the Messenger, so it must never outlive it: turning the integration
    off turns the gate off in the same motion. That is also what keeps a hard
    block out of CI, the e2e suite, preview, and demo, none of which set
    NEXT_PUBLIC_INTERCOM_APP_ID. */}
{supportAppId ? (
  <>
    <IntercomMessenger appId={supportAppId} />
    <BlockerGate appId={supportAppId} supportEmail={supportContact.email} />
  </>
) : null}
```

- [ ] **Step 4: Verify the whole suite, types, and lint**

Run each and read the actual counts. Do not pipe through `tail`.

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate" BLOB_READ_WRITE_TOKEN="" npm test
npm run typecheck
npx eslint src e2e
```

Expected: the suite matches the baseline recorded at the top of this branch (no new failures), typecheck clean, lint clean.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/layout.tsx"
git commit -m "feat(support): mount the content blocker gate on authenticated routes

Shares the Messenger's supportAppId guard so the gate cannot outlive the
feature it protects, and so it stays inert in CI, e2e, preview, and demo,
where a hard block would otherwise take the whole suite down."
```

---

### Task 4: Verify against a real content blocker

Tests cannot prove that the probes match what blockers actually do, because
the gate is inert without `NEXT_PUBLIC_INTERCOM_APP_ID` and setting it in the
e2e env would boot the real Messenger across the entire suite for one test.
This step is the only evidence that the feature works, so it is required
before merge, not optional.

**Files:** none.

- [ ] **Step 1: Deploy a preview with Intercom configured**

The preview needs `NEXT_PUBLIC_INTERCOM_APP_ID` and `INTERCOM_MESSENGER_SECRET`
set, or the gate stays inert and this proves nothing. Confirm the Messenger
bubble actually appears with the blocker off before testing with it on.

- [ ] **Step 2: Confirm the gate fires**

With uBlock Origin enabled, load an authenticated hub page. Expected: the gate
appears within a few seconds (one probe round plus the 2s retry).

Record which probe fired by checking the PostHog `content_blocker_gate_shown`
event's `probes` property. `widget` alone is the expected common case, since
EasyPrivacy blocks the Intercom CDN but not our own route.

- [ ] **Step 3: Confirm the gate clears**

Disable uBlock Origin for the site, then return to the tab without reloading.
Expected: the focus listener re-probes and the gate clears on its own. Then
repeat using the "I've turned it off" button instead.

- [ ] **Step 4: Confirm the false-positive guards hold**

Two checks, both of which must NOT gate:

1. With the blocker off, go offline (devtools Network, Offline) and reload.
   Expected: no gate. The control probe fails, so the probe stands down.
2. With the blocker off, block only `/brand/haven-mark.svg` in devtools
   (Network request blocking) and reload. Expected: no gate, same reason.

- [ ] **Step 5: Record the result**

Note the outcome of each check in the PR description, including which probe
fired in Step 2. If any check fails, stop and fix before merging rather than
weakening the check.

---

## Notes for the implementer

- **The gate is inert locally.** Without `NEXT_PUBLIC_INTERCOM_APP_ID` and
  `INTERCOM_MESSENGER_SECRET`, `supportAppId` is null and `BlockerGate` never
  mounts. That is intended, and it is why Task 4 exists.
- **Do not add bait requests.** A `/ads.js`-style bait or a cosmetic-filter
  bait element would catch blockers that break nothing, and every one of those
  is a member locked out of clinic work for no reason. The spec rules this out
  explicitly.
- **Do not soften the gate into something dismissible** without going back to
  the spec. The no-dismissal decision was made deliberately, with the lockout
  risk understood, and the design pays for it with the control probe and the
  retry rather than with an escape hatch.
