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
      // `environment` rides every server event: production, staging, preview and
      // local dev share one PostHog project, and server events carried nothing to
      // tell them apart (audit 14, OBS-05).
      properties: { count: 3, kind: "x", environment: "development" },
      groups: undefined,
    });
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("stamps the deployment environment on every server event", async () => {
    await captureEvent({ event: "e", distinctId: "person-1" });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({ environment: expect.any(String) }),
      }),
    );
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
        properties: expect.objectContaining({
          $set: { departments: ["SRHD", "PCAR"], active_term: "Fall 2026" },
        }),
      }),
    );
  });

  it("stamps email on the person when the distinct id is an email, verbatim", async () => {
    // Applicant events are keyed by email and set nothing else, so the PostHog
    // persons list showed ~1,500 of them as bare UUIDs. The id must be copied
    // exactly: trimming or lowercasing it would not match the existing person.
    await captureEvent({ event: "application_draft_saved", distinctId: "Applicant@Example.com" });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({ $set: { email: "Applicant@Example.com" } }),
      }),
    );
  });

  it("keeps caller person properties alongside the stamped email, and lets a caller email win", async () => {
    await captureEvent({
      event: "onboarding_contract_submitted",
      distinctId: "a@b.co",
      setPersonProperties: { name: "Jane Doe" },
    });
    expect(capture).toHaveBeenLastCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({ $set: { email: "a@b.co", name: "Jane Doe" } }),
      }),
    );

    await captureEvent({
      event: "e",
      distinctId: "a@b.co",
      setPersonProperties: { email: "other@b.co" },
    });
    expect(capture).toHaveBeenLastCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({ $set: { email: "other@b.co" } }),
      }),
    );
  });

  it("sets no person properties for a non-email distinct id", async () => {
    await captureEvent({ event: "e", distinctId: "person-1" });
    const props = capture.mock.calls[0][0].properties;
    expect(props).not.toHaveProperty("$set");
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
