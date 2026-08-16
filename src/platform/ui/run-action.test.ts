/**
 * Unit cover for the wrapper audit 14 added. The behaviour that matters is the one
 * line every modal was missing: a REJECTED action must come back as an `{ error }`
 * result, because that is the only shape the calling code checks.
 */
import { describe, expect, it } from "vitest";
import { ACTION_REJECTED_MESSAGE, runAction } from "./run-action";

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
    // A bound server action whose id no longer exists after a deploy throws on call,
    // before it ever returns a promise.
    const res = await runAction(() => {
      throw new Error("Failed to find Server Action");
    });
    expect(res.error).toBe(ACTION_REJECTED_MESSAGE);
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

  it("tells the user their work was not saved, so retrying is obviously safe", () => {
    expect(ACTION_REJECTED_MESSAGE).toMatch(/nothing was saved/i);
    expect(ACTION_REJECTED_MESSAGE).toMatch(/try again/i);
  });
});
