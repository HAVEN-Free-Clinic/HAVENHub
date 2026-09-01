// @vitest-environment jsdom
/**
 * Cover for the gap that let the `/login` stale Server Action recur after it was
 * marked fixed: the self-heals only listened on `window`, and a `<form action>`
 * rejection never reaches `window` -- React hands it to an error boundary.
 *
 * The behaviour that matters is that a boundary-caught error now spends the same
 * one reload the listener would have, and that an ordinary error still does not.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";

import {
  BOUNDARY_HEALS,
  isBoundaryRecoverableError,
  recoverBoundaryError,
} from "./boundary-recovery";
import { STALE_SERVER_ACTION_HEAL } from "./stale-server-action";
import { CHUNK_LOAD_HEAL } from "./chunk-load-crash";
import { UNEXPECTED_ACTION_RESPONSE_MESSAGE } from "./server-action-transport";

// The heal reloads the tab, which jsdom cannot do, and reports to posthog, which
// has no place in a unit test.
const reload = vi.fn();
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));

beforeEach(() => {
  reload.mockClear();
  sessionStorage.clear();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { reload, href: "https://hub.havenfreeclinic.org/login" },
  });
});

describe("recoverBoundaryError", () => {
  // The exact failure from Error Tracking issue 01a048d6: 8 events, 5 members,
  // every one on /login with handled: true, i.e. caught by a boundary.
  it("reloads out of a stale Server Action id caught by a boundary", () => {
    expect(recoverBoundaryError(new UnrecognizedActionError("Failed to find Server Action."))).toBe(
      true,
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads out of an unreadable Server Action response", () => {
    expect(recoverBoundaryError(new Error(UNEXPECTED_ACTION_RESPONSE_MESSAGE))).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads out of a chunk that failed to load inside a lazy component", () => {
    expect(recoverBoundaryError(new Error("Failed to load chunk /_next/static/chunks/a.js"))).toBe(
      true,
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("leaves an ordinary application error to the boundary's own retry", () => {
    expect(recoverBoundaryError(new Error("You no longer hold this permission."))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload a second time in the same tab, which would loop", () => {
    const stale = () => new UnrecognizedActionError("Failed to find Server Action.");
    expect(recoverBoundaryError(stale())).toBe(true);
    reload.mockClear();

    expect(recoverBoundaryError(stale())).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("spends only one reload even when several heals could match in a session", () => {
    // Separate storage keys, so a chunk failure after a stale action still gets
    // its own recovery rather than being swallowed by the other's spent key.
    expect(recoverBoundaryError(new UnrecognizedActionError("Failed to find Server Action."))).toBe(
      true,
    );
    expect(recoverBoundaryError(new Error("Failed to load chunk /_next/static/chunks/a.js"))).toBe(
      true,
    );
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

describe("BOUNDARY_HEALS", () => {
  it("shares the listener's heals, so one crash cannot buy two reloads", () => {
    // Same objects, therefore the same sessionStorage keys as the window
    // listeners installed from the root layout. A copy here would mean a tab
    // reloading once for the listener and again for the boundary.
    expect(BOUNDARY_HEALS).toContain(STALE_SERVER_ACTION_HEAL);
    expect(BOUNDARY_HEALS).toContain(CHUNK_LOAD_HEAL);
  });

  it("gives every heal its own storage key", () => {
    const keys = BOUNDARY_HEALS.map((heal) => heal.storageKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * The router hook crash kills Next's `Router`, which sits above every boundary
   * we own -- including global-error.tsx -- so it can never arrive here. Listing
   * it would imply a coverage we do not have. See router-hook-crash.ts.
   */
  it("omits the router hook crash, which no boundary can catch", () => {
    expect(BOUNDARY_HEALS.map((heal) => heal.storageKey)).not.toContain(
      "haven:router-hook-crash-recovered",
    );
  });
});

describe("isBoundaryRecoverableError", () => {
  /**
   * The render-time half. It must agree with `recoverBoundaryError` about which
   * errors are recoverable, or a boundary shows "reloading..." for something that
   * never reloads.
   */
  it.each([
    ["stale Server Action id", new UnrecognizedActionError("Failed to find Server Action.")],
    ["unreadable action response", new Error(UNEXPECTED_ACTION_RESPONSE_MESSAGE)],
    ["dropped chunk", new Error("Failed to load chunk /_next/static/chunks/a.js")],
  ])("recognises a %s", (_label, error) => {
    expect(isBoundaryRecoverableError(error)).toBe(true);
  });

  it("does not claim an ordinary application error", () => {
    expect(isBoundaryRecoverableError(new Error("You no longer hold this permission."))).toBe(false);
  });

  it("is pure, so a boundary can call it during render", () => {
    // No storage read: the answer must not change once a tab has spent its
    // reload, because render must not depend on sessionStorage.
    const error = new UnrecognizedActionError("Failed to find Server Action.");
    expect(isBoundaryRecoverableError(error)).toBe(true);
    recoverBoundaryError(error);
    expect(isBoundaryRecoverableError(error)).toBe(true);
  });

  it("agrees with recoverBoundaryError on a fresh tab", () => {
    for (const error of [
      new UnrecognizedActionError("Failed to find Server Action."),
      new Error(UNEXPECTED_ACTION_RESPONSE_MESSAGE),
      new Error("Failed to load chunk /_next/static/chunks/a.js"),
      new Error("something ordinary"),
    ]) {
      sessionStorage.clear();
      expect(recoverBoundaryError(error)).toBe(isBoundaryRecoverableError(error));
    }
  });
});
