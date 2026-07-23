import { describe, expect, it } from "vitest";

import {
  isNextControlFlowError,
  isNextControlFlowEvent,
} from "./next-control-flow";

describe("isNextControlFlowError", () => {
  it("matches a redirect() sentinel by its digest", () => {
    expect(
      isNextControlFlowError({ digest: "NEXT_REDIRECT;push;/incidents;307;" }),
    ).toBe(true);
  });

  it("matches a notFound() sentinel by its digest", () => {
    expect(isNextControlFlowError({ digest: "NEXT_NOT_FOUND" })).toBe(true);
  });

  it("does not match a real error with no digest", () => {
    expect(isNextControlFlowError({})).toBe(false);
  });

  it("does not match an unrelated digest", () => {
    expect(isNextControlFlowError({ digest: "1234567890" })).toBe(false);
  });
});

describe("isNextControlFlowEvent", () => {
  const exceptionEvent = (values: unknown[]) => ({
    event: "$exception",
    properties: { $exception_list: values.map((value) => ({ value })) },
  });

  it("matches an $exception whose only error is a redirect sentinel", () => {
    expect(isNextControlFlowEvent(exceptionEvent(["NEXT_REDIRECT"]))).toBe(true);
  });

  it("matches an $exception whose only error is a notFound sentinel", () => {
    expect(isNextControlFlowEvent(exceptionEvent(["NEXT_NOT_FOUND"]))).toBe(
      true,
    );
  });

  it("does not match a genuine exception", () => {
    expect(
      isNextControlFlowEvent(exceptionEvent(["TypeError: x is undefined"])),
    ).toBe(false);
  });

  it("does not drop an exception that mixes a sentinel with a real error", () => {
    expect(
      isNextControlFlowEvent(exceptionEvent(["NEXT_REDIRECT", "real boom"])),
    ).toBe(false);
  });

  it("ignores non-exception events", () => {
    expect(isNextControlFlowEvent({ event: "$pageview", properties: {} })).toBe(
      false,
    );
  });

  it("ignores an exception with an empty exception list", () => {
    expect(isNextControlFlowEvent(exceptionEvent([]))).toBe(false);
  });

  it("handles a null event", () => {
    expect(isNextControlFlowEvent(null)).toBe(false);
  });
});
