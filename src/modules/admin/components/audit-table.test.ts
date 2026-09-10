import { describe, expect, it } from "vitest";
import { auditActionLabel } from "./audit-table";

describe("auditActionLabel", () => {
  it("reads an action code as area and action in plain words", () => {
    expect(auditActionLabel("recruitment.application_submit")).toBe("Recruitment · Application submit");
    expect(auditActionLabel("schedule.unpublish")).toBe("Schedule · Unpublish");
  });

  it("turns a multi-word area into words too", () => {
    expect(auditActionLabel("intercom_ticket_sync.epic_ticket_closed_without_request")).toBe(
      "Intercom ticket sync · Epic ticket closed without request",
    );
  });

  it("keeps acronyms and names in their own casing, wherever they fall", () => {
    expect(auditActionLabel("ehs.training_update")).toBe("EHS · Training update");
    expect(auditActionLabel("ehs.added_to_ehs_import")).toBe("EHS · Added to EHS import");
    expect(auditActionLabel("ynhh.submit")).toBe("YNHH · Submit");
  });

  it("copes with a code that has no action part, or more than one dot", () => {
    expect(auditActionLabel("offboarding")).toBe("Offboarding");
    expect(auditActionLabel("support.request.cancel_own")).toBe("Support · Request cancel own");
  });
});
