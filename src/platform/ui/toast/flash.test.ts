import { describe, it, expect } from "vitest";
import { classifyFlashParams } from "./flash";

/** Build a URLSearchParams from a plain object, the shape every test needs. */
function paramsOf(entries: Record<string, string>): URLSearchParams {
  return new URLSearchParams(entries);
}

describe("classifyFlashParams", () => {
  it("claims error, error tone, message is the param's own decoded value", () => {
    const result = classifyFlashParams(paramsOf({ error: "Something went wrong" }));
    expect(result.toasts).toEqual([{ tone: "error", message: "Something went wrong" }]);
    expect(result.stripParams).toEqual(["error"]);
  });

  it("claims rosterError by the /Error$/ convention", () => {
    const result = classifyFlashParams(paramsOf({ rosterError: "Roster line 4 is invalid." }));
    expect(result.toasts).toEqual([{ tone: "error", message: "Roster line 4 is invalid." }]);
    expect(result.stripParams).toEqual(["rosterError"]);
  });

  it("claims rbacError by the /Error$/ convention", () => {
    const result = classifyFlashParams(paramsOf({ rbacError: "That grant already exists." }));
    expect(result.toasts).toEqual([{ tone: "error", message: "That grant already exists." }]);
    expect(result.stripParams).toEqual(["rbacError"]);
  });

  it("claims senderError by the /Error$/ convention", () => {
    const result = classifyFlashParams(
      paramsOf({ senderError: "No global send-from address is configured yet." }),
    );
    expect(result.toasts).toEqual([
      { tone: "error", message: "No global send-from address is configured yet." },
    ]);
    expect(result.stripParams).toEqual(["senderError"]);
  });

  it("claims certError by the /Error$/ convention", () => {
    const result = classifyFlashParams(paramsOf({ certError: "Choose a PDF file." }));
    expect(result.toasts).toEqual([{ tone: "error", message: "Choose a PDF file." }]);
    expect(result.stripParams).toEqual(["certError"]);
  });

  it("claims message alongside error, as its validation detail payload", () => {
    const result = classifyFlashParams(
      paramsOf({ error: "validation", message: "Pick a department first." }),
    );
    expect(result.toasts).toEqual([{ tone: "error", message: "Pick a department first." }]);
    expect(result.stripParams.sort()).toEqual(["error", "message"]);
  });

  it("does not claim message when error is absent", () => {
    const result = classifyFlashParams(paramsOf({ message: "orphaned detail text" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim status, a validated filter on five pages", () => {
    const result = classifyFlashParams(paramsOf({ status: "FAILED" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim page, a pagination cursor", () => {
    const result = classifyFlashParams(paramsOf({ page: "3" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim q, a search filter", () => {
    const result = classifyFlashParams(paramsOf({ q: "smith" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim tab, a view selector", () => {
    const result = classifyFlashParams(paramsOf({ tab: "overview" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim token, a magic-link credential", () => {
    const result = classifyFlashParams(paramsOf({ token: "abc123" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim view, a display mode", () => {
    const result = classifyFlashParams(paramsOf({ view: "grid" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim mode, a display mode", () => {
    const result = classifyFlashParams(paramsOf({ mode: "compact" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim date, a calendar filter", () => {
    const result = classifyFlashParams(paramsOf({ date: "2026-07-30" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim dept, a department filter", () => {
    const result = classifyFlashParams(paramsOf({ dept: "clinical" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim term, a term filter", () => {
    const result = classifyFlashParams(paramsOf({ term: "SU26" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim track, a track filter", () => {
    const result = classifyFlashParams(paramsOf({ track: "DIRECTOR" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim next, a post-login redirect target", () => {
    const result = classifyFlashParams(paramsOf({ next: "/dashboard" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim callbackUrl, an auth redirect target", () => {
    const result = classifyFlashParams(paramsOf({ callbackUrl: "/apply/clinical" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim type, a notification-type filter", () => {
    const result = classifyFlashParams(paramsOf({ type: "SHIFT_REMINDER" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim priority, an incident filter", () => {
    const result = classifyFlashParams(paramsOf({ priority: "high" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim category, an incident filter", () => {
    const result = classifyFlashParams(paramsOf({ category: "safety" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim assignee, an incident filter", () => {
    const result = classifyFlashParams(paramsOf({ assignee: "abc123" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim departmentId, a department filter", () => {
    const result = classifyFlashParams(paramsOf({ departmentId: "clinical" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("claims only the flash param when a flash and a filter share a URL", () => {
    const result = classifyFlashParams(paramsOf({ saved: "1", status: "FAILED" }));
    expect(result.toasts).toEqual([{ tone: "success", message: "Saved." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  it("claims saved=1, success tone, with the registry's message", () => {
    const result = classifyFlashParams(paramsOf({ saved: "1" }));
    expect(result.toasts).toEqual([{ tone: "success", message: "Saved." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  it("claims sent and skipped together as one toast and strips both", () => {
    const result = classifyFlashParams(paramsOf({ sent: "4", skipped: "2" }));
    expect(result.toasts).toEqual([
      {
        tone: "success",
        message: "Released 4 acceptance email(s); skipped 2 conflicted applicant(s).",
      },
    ]);
    expect(result.stripParams.sort()).toEqual(["sent", "skipped"]);
  });

  it("does not claim a bare sent without its skipped partner", () => {
    // admin/email/campaigns/[id]/page.tsx sets `sent` alone, meaning something else entirely
    // ("Campaign sent to N recipients"); only the decisions page pairs it with `skipped`.
    const result = classifyFlashParams(paramsOf({ sent: "12" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim an unknown param", () => {
    const result = classifyFlashParams(paramsOf({ foo: "bar" }));
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });
});
