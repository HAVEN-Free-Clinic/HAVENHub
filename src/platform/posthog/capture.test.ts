import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolate from the real posthog-node client: capture/flush/alias are shared
// module-level spies so assertions hold regardless of which client instance the
// helper pulls from getPostHogClient().
const capture = vi.fn();
const flush = vi.fn(async () => {});
const alias = vi.fn();
vi.mock("@/platform/posthog/posthog-server", () => ({
  getPostHogClient: () => ({ capture, flush, alias }),
}));

import { aliasPerson, captureEvent, flushEvents, GROUP_DEPARTMENT, GROUP_TERM } from "./capture";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("captureEvent", () => {
  it("captures the event with distinctId and drops undefined properties, then flushes", async () => {
    await captureEvent({
      event: "thing_happened",
      distinctId: "person-1",
      properties: { count: 3, note: undefined, kind: "x" },
    });
    expect(capture).toHaveBeenCalledWith({
      distinctId: "person-1",
      event: "thing_happened",
      properties: { count: 3, kind: "x" },
      groups: undefined,
    });
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("attaches non-empty groups and drops empty group values", async () => {
    await captureEvent({
      event: "thing_happened",
      distinctId: "person-1",
      groups: { [GROUP_TERM]: "term-1", [GROUP_DEPARTMENT]: "" },
    });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ groups: { term: "term-1" } }),
    );
  });

  it("merges setPersonProperties into $set on the event properties", async () => {
    await captureEvent({
      event: "user_signed_in",
      distinctId: "person-1",
      setPersonProperties: { departments: ["SRHD", "PCAR"], active_term: "Fall 2026" },
    });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: { $set: { departments: ["SRHD", "PCAR"], active_term: "Fall 2026" } },
      }),
    );
  });

  it("does not flush when flush is false", async () => {
    await captureEvent({ event: "e", distinctId: "person-1", flush: false });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(flush).not.toHaveBeenCalled();
  });
});

describe("aliasPerson", () => {
  it("aliases the previous distinctId into the person id and flushes", async () => {
    await aliasPerson({ personId: "person-1", previousDistinctId: "applicant@example.com" });
    expect(alias).toHaveBeenCalledWith({ distinctId: "person-1", alias: "applicant@example.com" });
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("skips the flush when flush is false", async () => {
    await aliasPerson({ personId: "person-1", previousDistinctId: "a@b.co", flush: false });
    expect(alias).toHaveBeenCalledTimes(1);
    expect(flush).not.toHaveBeenCalled();
  });
});

describe("flushEvents", () => {
  it("flushes the client", async () => {
    await flushEvents();
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
