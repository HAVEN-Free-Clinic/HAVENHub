/**
 * Tests for the coerced non-Error placeholder filter.
 *
 * The load-bearing half is the NEGATIVE cases: a filter on the error-reporting
 * path fails silently, so the tests that matter are the ones proving it does not
 * eat our own exceptions.
 */

import { describe, expect, it } from "vitest";
import { isNonErrorThrowEvent } from "./nonerror-throw";

const exceptionEvent = (list: unknown) => ({
  event: "$exception",
  properties: { $exception_list: list },
});

const OURS = "https://hub.havenfreeclinic.org/_next/static/chunk.js";
const MASKED = "webkit-masked-url://hidden/";

/**
 * The shape posthog-js builds when it coerces a thrown non-Error value:
 * synthetic and unhandled by default. Pass `frames` to attach a stack; omit it
 * for the stackless placeholders.
 */
const coerced = (
  value: string,
  {
    synthetic = true,
    handled = false,
    frames,
  }: { synthetic?: boolean; handled?: boolean; frames?: unknown[] } = {},
) => ({
  value,
  mechanism: { synthetic, handled },
  ...(frames === undefined ? {} : { stacktrace: { frames } }),
});

describe("isNonErrorThrowEvent", () => {
  // The three real captures that motivated this: one Safari 27 visit to an
  // /onboard/<token> page, three coerced non-Errors in two seconds.

  it("drops a thrown event whose value posthog-js coerced (no stack)", () => {
    expect(
      isNonErrorThrowEvent(
        exceptionEvent([coerced("CustomEvent captured as exception with keys: isTrusted")]),
      ),
    ).toBe(true);
  });

  it("drops a thrown empty object (no stack)", () => {
    expect(
      isNonErrorThrowEvent(
        exceptionEvent([coerced("Object captured as exception with keys: [object has no keys]")]),
      ),
    ).toBe(true);
  });

  it("drops a thrown object with a single masked-URL frame", () => {
    expect(
      isNonErrorThrowEvent(
        exceptionEvent([
          coerced("'TimeoutError' captured as exception with message: 'operation timed out'", {
            frames: [{ filename: MASKED }],
          }),
        ]),
      ),
    ).toBe(true);
  });

  it("drops it when the stack is present but empty", () => {
    expect(
      isNonErrorThrowEvent(
        exceptionEvent([coerced("Object captured as exception with keys: a, b", { frames: [] })]),
      ),
    ).toBe(true);
  });

  // --- Everything below must be KEPT ---

  it("keeps a real error, which is never coerced (synthetic false)", () => {
    expect(
      isNonErrorThrowEvent(
        exceptionEvent([
          coerced("x is not a function", { synthetic: false, frames: [{ filename: OURS }] }),
        ]),
      ),
    ).toBe(false);
  });

  it("keeps a non-Error we captured on purpose (handled true)", () => {
    expect(
      isNonErrorThrowEvent(
        exceptionEvent([coerced("Object captured as exception with keys: code", { handled: true })]),
      ),
    ).toBe(false);
  });

  it("keeps a coerced value that still points at one of our files", () => {
    expect(
      isNonErrorThrowEvent(
        exceptionEvent([
          coerced("Object captured as exception with keys: code", { frames: [{ filename: OURS }] }),
        ]),
      ),
    ).toBe(false);
  });

  it("keeps a coerced value when only some frames are masked", () => {
    expect(
      isNonErrorThrowEvent(
        exceptionEvent([
          coerced("Object captured as exception with keys: code", {
            frames: [{ filename: MASKED }, { filename: OURS }],
          }),
        ]),
      ),
    ).toBe(false);
  });

  it("keeps a primitive non-Error rejection (different wording)", () => {
    expect(
      isNonErrorThrowEvent(
        exceptionEvent([coerced("Non-Error promise rejection captured with value: save failed")]),
      ),
    ).toBe(false);
  });

  it("keeps a real error whose message merely mentions the marker", () => {
    expect(
      isNonErrorThrowEvent(
        exceptionEvent([
          coerced("handled input captured as exception audit", {
            synthetic: false,
            frames: [{ filename: OURS }],
          }),
        ]),
      ),
    ).toBe(false);
  });

  // Dropping this would lose a real defect because a placeholder happened to
  // arrive in the same batch.
  it("keeps a batch that mixes the placeholder with one of ours", () => {
    expect(
      isNonErrorThrowEvent(
        exceptionEvent([
          coerced("CustomEvent captured as exception with keys: isTrusted"),
          coerced("our real bug", { synthetic: false, frames: [{ filename: OURS }] }),
        ]),
      ),
    ).toBe(false);
  });

  it("ignores non-exception events and malformed payloads", () => {
    expect(isNonErrorThrowEvent(null)).toBe(false);
    expect(isNonErrorThrowEvent({ event: "$pageview" })).toBe(false);
    expect(isNonErrorThrowEvent(exceptionEvent([]))).toBe(false);
    expect(isNonErrorThrowEvent(exceptionEvent("not-an-array"))).toBe(false);
    expect(isNonErrorThrowEvent(exceptionEvent([null, undefined, 42]))).toBe(false);
  });
});
