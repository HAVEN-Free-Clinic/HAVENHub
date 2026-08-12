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
