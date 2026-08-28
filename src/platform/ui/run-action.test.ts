// @vitest-environment jsdom
/**
 * Unit cover for the wrapper audit 14 added. The behaviour that matters is the one
 * line every modal was missing: a REJECTED action must come back as an `{ error }`
 * result, because that is the only shape the calling code checks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import { ACTION_REJECTED_MESSAGE, runAction } from "./run-action";
import { STALE_DEPLOY_MESSAGE } from "@/platform/posthog/stale-server-action";

// The self-heal reloads the tab, which jsdom cannot do, and reports to posthog,
// which has no place in a unit test. Both are covered by their own modules; what
// matters here is which message runAction returns.
const reload = vi.fn();
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));

describe("runAction", () => {
  it("passes a successful result straight through", async () => {
    const res = await runAction(async () => ({ ok: true }) as { ok: boolean; error?: string });
    expect(res).toEqual({ ok: true });
  });

  it("passes a HANDLED failure straight through, message intact", async () => {
    const res = await runAction(async () => ({ error: "You no longer hold this permission." }));
    expect(res.error).toBe("You no longer hold this permission.");
  });

  it("turns a rejection into the same {error} shape callers already check", async () => {
    const res = await runAction(async () => {
      throw new Error("PrismaClientKnownRequestError");
    });
    expect(res.error).toBe(ACTION_REJECTED_MESSAGE);
  });

  it("turns a synchronous throw into an {error} too", async () => {
    // Thrown on call, before it ever returns a promise.
    const res = await runAction(() => {
      throw new Error("kaboom");
    });
    expect(res.error).toBe(ACTION_REJECTED_MESSAGE);
  });

  // A plain Error carrying Next's wording is NOT a stale deploy: anything can
  // write that sentence. Only Next's own error type triggers the reload, so this
  // must still get the ordinary message. See stale-server-action.ts.
  it("does not treat a look-alike message as a stale deploy", async () => {
    const res = await runAction(async () => {
      throw new Error("Failed to find Server Action");
    });
    expect(res.error).toBe(ACTION_REJECTED_MESSAGE);
    expect(reload).not.toHaveBeenCalled();
  });

  it("never rethrows, so it cannot leave an unhandled rejection inside a transition", async () => {
    await expect(
      runAction(async () => {
        throw new Error("boom");
      }),
    ).resolves.toBeTruthy();
  });

  it("accepts a caller-specific message", async () => {
    const res = await runAction(async () => {
      throw new Error("boom");
    }, "Could not record the score.");
    expect(res.error).toBe("Could not record the score.");
  });

  describe("a Server Action the running deploy no longer has", () => {
    beforeEach(() => {
      reload.mockClear();
      sessionStorage.clear();
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { reload, href: "https://hub.example.org/schedule" },
      });
    });

    it("reloads onto the new bundle instead of telling the user to retry", async () => {
      const res = await runAction(async () => {
        throw new UnrecognizedActionError("Failed to find Server Action.");
      });
      expect(reload).toHaveBeenCalledTimes(1);
      expect(res.error).toBe(STALE_DEPLOY_MESSAGE);
      // The advice that cannot work here, because the retry re-sends the dead id.
      expect(res.error).not.toMatch(/try again/i);
    });

    it("does not reload a second time in the same tab", async () => {
      const throwStale = async () => {
        throw new UnrecognizedActionError("Failed to find Server Action.");
      };
      await runAction(throwStale);
      reload.mockClear();

      // The reload did not land us on a working bundle, so reloading again would
      // loop. Fall back to the ordinary message.
      const res = await runAction(throwStale);
      expect(reload).not.toHaveBeenCalled();
      expect(res.error).toBe(ACTION_REJECTED_MESSAGE);
    });

    it("still overrides a caller-specific message, which would also say retry", async () => {
      const res = await runAction(async () => {
        throw new UnrecognizedActionError("Failed to find Server Action.");
      }, "Could not record the score.");
      expect(res.error).toBe(STALE_DEPLOY_MESSAGE);
    });
  });

  it("tells the user their work was not saved, so retrying is obviously safe", () => {
    expect(ACTION_REJECTED_MESSAGE).toMatch(/nothing was saved/i);
    expect(ACTION_REJECTED_MESSAGE).toMatch(/try again/i);
  });
});
