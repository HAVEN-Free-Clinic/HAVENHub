import { describe, expect, it } from "vitest";
import { notFound, redirect } from "next/navigation";

import {
  isNextControlFlowError,
  isNextControlFlowEvent,
} from "./next-control-flow";

/** Run a function expected to throw and hand back what it threw. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw a sentinel");
}

/** The `$exception` shape posthog-js sends: the message lands in `value`. */
const exceptionEvent = (values: unknown[]) => ({
  event: "$exception",
  properties: {
    $exception_list: values.map((value) => ({ type: "Error", value })),
  },
});

describe("isNextControlFlowError", () => {
  // Pinned to the framework rather than to hardcoded strings: if Next renames a
  // sentinel (it renamed NEXT_NOT_FOUND to NEXT_HTTP_ERROR_FALLBACK), these fail
  // instead of the filter quietly going dead.
  it("matches what redirect() actually throws", () => {
    expect(isNextControlFlowError(thrown(() => redirect("/no-access")))).toBe(
      true,
    );
  });

  it("matches what notFound() actually throws", () => {
    expect(isNextControlFlowError(thrown(() => notFound()))).toBe(true);
  });

  it("matches a sentinel by digest alone, with the message scrubbed", () => {
    // How a server-component sentinel reaches an error boundary in production.
    const error = Object.assign(
      new Error("An error occurred in the Server Components render."),
      { digest: "NEXT_REDIRECT;replace;/no-access;307;" },
    );
    expect(isNextControlFlowError(error)).toBe(true);
  });

  it("does not match a real error", () => {
    expect(isNextControlFlowError(new Error("boom"))).toBe(false);
  });

  it("does not match a real error carrying a production digest", () => {
    expect(
      isNextControlFlowError(
        Object.assign(new Error("boom"), { digest: "1234567890" }),
      ),
    ).toBe(false);
  });

  it("handles non-object throws", () => {
    expect(isNextControlFlowError(null)).toBe(false);
    expect(isNextControlFlowError("NEXT_REDIRECT")).toBe(false);
  });
});

describe("isNextControlFlowEvent", () => {
  it("drops the $exception posthog-js builds from a real redirect sentinel", () => {
    const error = thrown(() => redirect("/no-access")) as Error;
    expect(
      isNextControlFlowEvent(exceptionEvent([error.message])),
    ).toBe(true);
  });

  it("drops the $exception posthog-js builds from a real notFound sentinel", () => {
    const error = thrown(() => notFound()) as Error;
    expect(isNextControlFlowEvent(exceptionEvent([error.message]))).toBe(true);
  });

  it("keeps a genuine exception", () => {
    expect(
      isNextControlFlowEvent(exceptionEvent(["TypeError: x is undefined"])),
    ).toBe(false);
  });

  it("keeps an exception that mixes a sentinel with a real error", () => {
    expect(
      isNextControlFlowEvent(exceptionEvent(["NEXT_REDIRECT", "real boom"])),
    ).toBe(false);
  });

  it("ignores events that are not exceptions", () => {
    expect(isNextControlFlowEvent({ event: "$pageview", properties: {} })).toBe(
      false,
    );
  });

  it("ignores an exception with no usable exception list", () => {
    expect(isNextControlFlowEvent(exceptionEvent([]))).toBe(false);
    expect(
      isNextControlFlowEvent({
        event: "$exception",
        properties: { $exception_list: "not a list" },
      }),
    ).toBe(false);
    expect(isNextControlFlowEvent({ event: "$exception" })).toBe(false);
  });

  it("handles a null event", () => {
    expect(isNextControlFlowEvent(null)).toBe(false);
  });
});
