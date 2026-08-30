/**
 * Tests for the next-auth session-poll network-blip filter.
 *
 * As with the other before_send filters, the load-bearing half is the NEGATIVE
 * cases: a filter on the error-reporting path fails silently, so what matters is
 * proving it does not eat our own exceptions -- including real failures that
 * happen to be a fetch, and real next-auth bugs that happen to be a TypeError.
 */

import { describe, expect, it } from "vitest";
import { isAuthSessionPollEvent } from "./auth-session-poll";

const exceptionEvent = (list: unknown) => ({
  event: "$exception",
  properties: { $exception_list: list },
});

const nextAuthFrame = {
  source: "turbopack:///[project]/node_modules/next-auth/react.js",
  in_app: false,
};

const appFrame = { source: "turbopack:///[project]/src/modules/schedule/page.tsx", in_app: true };

const pollFailure = (value = "Failed to fetch", frames: unknown[] = [nextAuthFrame]) => ({
  type: "TypeError",
  value,
  mechanism: { handled: false, synthetic: false },
  stacktrace: { frames },
});

describe("isAuthSessionPollEvent", () => {
  // The real capture: 2 events, 2 members, one frame inside next-auth/react.js.
  it("drops the session poll losing its fetch", () => {
    expect(isAuthSessionPollEvent(exceptionEvent([pollFailure()]))).toBe(true);
  });

  it("drops the other engines' wording for the same failure", () => {
    for (const message of [
      "NetworkError when attempting to fetch resource.",
      "Load failed",
      "The network connection was lost.",
    ]) {
      expect(isAuthSessionPollEvent(exceptionEvent([pollFailure(message)]))).toBe(true);
    }
  });

  it("reads the webpack and bare-URL frame spellings too", () => {
    for (const source of [
      "webpack-internal:///./node_modules/next-auth/react.js",
      "https://hub.havenfreeclinic.org/_next/static/chunks/node_modules/next-auth/react.js",
    ]) {
      expect(
        isAuthSessionPollEvent(exceptionEvent([pollFailure("Failed to fetch", [{ source }])])),
      ).toBe(true);
    }
  });

  // --- Everything below must be KEPT ---

  it("keeps a fetch failure from our own code", () => {
    expect(isAuthSessionPollEvent(exceptionEvent([pollFailure("Failed to fetch", [appFrame])]))).toBe(
      false,
    );
  });

  it("keeps a mixed stack, where our code called next-auth and broke", () => {
    // `every`, not `some`: the real error is the signal.
    expect(
      isAuthSessionPollEvent(
        exceptionEvent([pollFailure("Failed to fetch", [nextAuthFrame, appFrame])]),
      ),
    ).toBe(false);
  });

  it("keeps a real next-auth bug that is not a network failure", () => {
    expect(
      isAuthSessionPollEvent(exceptionEvent([pollFailure("callbackUrl is not a valid URL")])),
    ).toBe(false);
  });

  it("keeps a non-TypeError from next-auth", () => {
    expect(
      isAuthSessionPollEvent(
        exceptionEvent([{ ...pollFailure(), type: "Error" }]),
      ),
    ).toBe(false);
  });

  it("keeps a frameless 'Failed to fetch', which could have come from anywhere", () => {
    expect(isAuthSessionPollEvent(exceptionEvent([pollFailure("Failed to fetch", [])]))).toBe(false);
    expect(
      isAuthSessionPollEvent(
        exceptionEvent([
          { type: "TypeError", value: "Failed to fetch", mechanism: { handled: false } },
        ]),
      ),
    ).toBe(false);
  });

  it("keeps the posthog replay recorder's own fetch failure", () => {
    // Ruled SDK noise and suppressed in Error Tracking separately; not this
    // filter's business, and it must not silently claim it.
    expect(
      isAuthSessionPollEvent(
        exceptionEvent([
          pollFailure("Failed to fetch", [{ source: "/ingest/static/posthog-recorder.js" }]),
        ]),
      ),
    ).toBe(false);
  });

  it("ignores events that are not exceptions", () => {
    expect(isAuthSessionPollEvent({ event: "$pageview", properties: {} })).toBe(false);
    expect(isAuthSessionPollEvent(null)).toBe(false);
    expect(isAuthSessionPollEvent(exceptionEvent([]))).toBe(false);
  });
});
