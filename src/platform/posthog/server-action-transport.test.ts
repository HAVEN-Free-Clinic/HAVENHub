/**
 * Tests for the "Server Action response was not a Server Action response"
 * predicate.
 *
 * This predicate spends a page reload, and it is matched on a message string
 * because Next gives us nothing better (see server-action-transport.ts for why
 * the `__NEXT_ERROR_CODE` is unusable). So the load-bearing half here is the
 * NEGATIVE cases: proving it cannot reload on anything but the one sentence.
 */

import { describe, expect, it } from "vitest";
import {
  UNEXPECTED_ACTION_RESPONSE_MESSAGE,
  decideServerActionTransportRecovery,
  isServerActionTransportError,
} from "./server-action-transport";

describe("isServerActionTransportError", () => {
  // The real capture that motivated this: 5 events on /my-info, Aug 18-19,
  // single frame at Next's fetchServerAction.
  it("recognises Next's generic unreadable-response error", () => {
    expect(
      isServerActionTransportError(new Error(UNEXPECTED_ACTION_RESPONSE_MESSAGE)),
    ).toBe(true);
  });

  // --- Everything below must be KEPT, i.e. must NOT trigger a reload ---

  it("does not match a message that merely contains the sentence", () => {
    expect(
      isServerActionTransportError(
        new Error(`Saving failed: ${UNEXPECTED_ACTION_RESPONSE_MESSAGE}`),
      ),
    ).toBe(false);
  });

  it("does not match the server's own text/plain error body", () => {
    // The same branch in Next substitutes the response body when status >= 400.
    // That carries a real server message and must stay visible in Error Tracking.
    expect(isServerActionTransportError(new Error("Database connection lost"))).toBe(false);
  });

  it("does not match an ordinary application error", () => {
    expect(isServerActionTransportError(new Error("You no longer hold this permission."))).toBe(
      false,
    );
  });

  it("does not match a non-error value", () => {
    expect(isServerActionTransportError(null)).toBe(false);
    expect(isServerActionTransportError(undefined)).toBe(false);
    expect(isServerActionTransportError(UNEXPECTED_ACTION_RESPONSE_MESSAGE)).toBe(false);
  });

  /**
   * Pins the sentence copied out of `next/dist/.../server-action-reducer.js`.
   * This test passing does NOT prove the recovery still fires -- it asserts our
   * own constant. It exists so that a `next` upgrade which reworded the message
   * has one obvious place to be re-checked against, named in the failure.
   */
  it("keeps the sentence verbatim from Next", () => {
    expect(UNEXPECTED_ACTION_RESPONSE_MESSAGE).toBe(
      "An unexpected response was received from the server.",
    );
  });
});

describe("decideServerActionTransportRecovery", () => {
  it("reloads the first time", () => {
    expect(
      decideServerActionTransportRecovery(new Error(UNEXPECTED_ACTION_RESPONSE_MESSAGE), false),
    ).toBe("reload");
  });

  it("does not reload a second time, which would loop", () => {
    expect(
      decideServerActionTransportRecovery(new Error(UNEXPECTED_ACTION_RESPONSE_MESSAGE), true),
    ).toBe("already-recovered");
  });

  it("leaves an unrelated error alone", () => {
    expect(decideServerActionTransportRecovery(new Error("boom"), false)).toBe("unrelated");
  });
});
