/**
 * Tests for the opaque cross-origin "Script error." filter.
 *
 * The load-bearing half is the NEGATIVE cases: a filter on the error-reporting
 * path fails silently, so the tests that matter are the ones proving it does not
 * eat our own exceptions.
 */

import { describe, expect, it } from "vitest";
import { isScriptErrorEvent } from "./script-error";

const exceptionEvent = (list: unknown) => ({
  event: "$exception",
  properties: { $exception_list: list },
});

/** The shape posthog-js builds for a redacted cross-origin `window.onerror`. */
const opaque = (value: string) => ({
  type: "Error",
  value,
  mechanism: { synthetic: true, handled: false },
  stacktrace: { type: "raw", frames: [] },
});

describe("isScriptErrorEvent", () => {
  // The real capture that motivated this: Firefox iOS at the site root.
  it("drops the opaque cross-origin report", () => {
    expect(isScriptErrorEvent(exceptionEvent([opaque("Script error.")]))).toBe(true);
  });

  it("drops the bare WebKit variant", () => {
    expect(isScriptErrorEvent(exceptionEvent([opaque("Script error")]))).toBe(true);
  });

  it("drops it when the stack key is absent, not just empty", () => {
    expect(
      isScriptErrorEvent(
        exceptionEvent([
          { type: "Error", value: "Script error.", mechanism: { synthetic: true, handled: false } },
        ]),
      ),
    ).toBe(true);
  });

  // --- Everything below must be KEPT ---

  it("keeps a handled exception that happens to carry the placeholder", () => {
    expect(
      isScriptErrorEvent(
        exceptionEvent([
          {
            type: "Error",
            value: "Script error.",
            mechanism: { synthetic: true, handled: true },
            stacktrace: { frames: [] },
          },
        ]),
      ),
    ).toBe(false);
  });

  it("keeps a non-synthetic exception that carries the placeholder", () => {
    expect(
      isScriptErrorEvent(
        exceptionEvent([
          {
            type: "Error",
            value: "Script error.",
            mechanism: { synthetic: false, handled: false },
            stacktrace: { frames: [] },
          },
        ]),
      ),
    ).toBe(false);
  });

  it("keeps a real error that has a stack, even with the same value", () => {
    expect(
      isScriptErrorEvent(
        exceptionEvent([
          {
            type: "Error",
            value: "Script error.",
            mechanism: { synthetic: true, handled: false },
            stacktrace: {
              frames: [{ filename: "https://hub.havenfreeclinic.org/_next/static/chunk.js" }],
            },
          },
        ]),
      ),
    ).toBe(false);
  });

  it("keeps an error whose message merely starts with the placeholder", () => {
    expect(isScriptErrorEvent(exceptionEvent([opaque("Script error. See console.")]))).toBe(false);
  });

  it("keeps ordinary application exceptions", () => {
    expect(isScriptErrorEvent(exceptionEvent([opaque("boom")]))).toBe(false);
    expect(isScriptErrorEvent(exceptionEvent([opaque("x is not a function")]))).toBe(false);
  });

  // Dropping this would lose a real defect because an opaque report happened to
  // arrive in the same batch.
  it("keeps a batch that mixes the placeholder with one of ours", () => {
    expect(
      isScriptErrorEvent(
        exceptionEvent([
          opaque("Script error."),
          {
            type: "TypeError",
            value: "our real bug",
            mechanism: { synthetic: false, handled: false },
            stacktrace: {
              frames: [{ filename: "https://hub.havenfreeclinic.org/_next/static/chunk.js" }],
            },
          },
        ]),
      ),
    ).toBe(false);
  });

  it("ignores non-exception events and malformed payloads", () => {
    expect(isScriptErrorEvent(null)).toBe(false);
    expect(isScriptErrorEvent({ event: "$pageview" })).toBe(false);
    expect(isScriptErrorEvent(exceptionEvent([]))).toBe(false);
    expect(isScriptErrorEvent(exceptionEvent("not-an-array"))).toBe(false);
    expect(isScriptErrorEvent(exceptionEvent([null, undefined, 42]))).toBe(false);
  });
});
