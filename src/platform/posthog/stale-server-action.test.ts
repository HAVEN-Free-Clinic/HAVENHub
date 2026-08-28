/**
 * The detection here delegates to Next's own predicate, so these tests are
 * mostly about the two ways that can silently stop working: the export
 * disappearing in a `next` upgrade, and the predicate quietly widening to match
 * errors that are not a stale deploy. A false positive is expensive -- it
 * reloads the page under someone mid-form -- so the negative cases carry the
 * weight.
 */

import { describe, expect, it } from "vitest";
import * as nextNavigation from "next/navigation";
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";

import {
  decideStaleServerActionRecovery,
  isStaleServerActionError,
  STALE_DEPLOY_MESSAGE,
  STALE_SERVER_ACTION_HEAL,
} from "./stale-server-action";

/** The error Next throws when the running deploy does not know the action id. */
const staleError = () =>
  new UnrecognizedActionError(
    "Failed to find Server Action. This request might be from an older or newer deployment.",
  );

describe("the Next API this module depends on", () => {
  // `unstable_` names the API's stability, not the behaviour's. If a next
  // upgrade renames or drops it, fail here rather than silently detecting
  // nothing and leaving members back on "please try again".
  it("still exports unstable_isUnrecognizedActionError from next/navigation", () => {
    expect(typeof nextNavigation.unstable_isUnrecognizedActionError).toBe("function");
  });
});

describe("isStaleServerActionError", () => {
  it("matches Next's UnrecognizedActionError", () => {
    expect(isStaleServerActionError(staleError())).toBe(true);
  });

  // --- Everything below must NOT match: each would reload a working page ---

  it("ignores an ordinary rejection from a server action", () => {
    expect(isStaleServerActionError(new Error("Prisma write failed"))).toBe(false);
    expect(isStaleServerActionError(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("ignores an error that merely carries the same message text", () => {
    // Message matching is what this module deliberately does not do.
    expect(
      isStaleServerActionError(
        new Error("Failed to find Server Action. This request might be from an older deployment."),
      ),
    ).toBe(false);
  });

  it("ignores an impostor that only claims the name", () => {
    const fake = Object.assign(new Error("nope"), { name: "UnrecognizedActionError" });
    expect(isStaleServerActionError(fake)).toBe(false);
  });

  it("handles non-error throws", () => {
    expect(isStaleServerActionError(null)).toBe(false);
    expect(isStaleServerActionError(undefined)).toBe(false);
    expect(isStaleServerActionError("Failed to find Server Action")).toBe(false);
    expect(isStaleServerActionError(404)).toBe(false);
  });
});

describe("decideStaleServerActionRecovery", () => {
  it("reloads on the first stale action in a tab", () => {
    expect(decideStaleServerActionRecovery(staleError(), false)).toBe("reload");
  });

  it("refuses a second reload in the same tab", () => {
    // A stale id that survives the reload is not the deploy skew this is for,
    // and reloading again would loop on the door to the whole Hub.
    expect(decideStaleServerActionRecovery(staleError(), true)).toBe("already-recovered");
  });

  it("leaves every other error alone", () => {
    expect(decideStaleServerActionRecovery(new Error("boom"), false)).toBe("unrelated");
  });
});

describe("STALE_SERVER_ACTION_HEAL", () => {
  it("uses a key of its own, so it cannot spend another crash's reload", () => {
    expect(STALE_SERVER_ACTION_HEAL.storageKey).toBe("haven:stale-server-action-recovered");
  });

  it("tells the member a reload is happening rather than to retry", () => {
    // The whole point: "try again" re-sends the same dead id.
    expect(STALE_DEPLOY_MESSAGE).not.toMatch(/try again/i);
    expect(STALE_DEPLOY_MESSAGE).toMatch(/reload/i);
  });
});
