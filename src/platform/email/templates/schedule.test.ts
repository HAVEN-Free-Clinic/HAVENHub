import { describe, expect, it } from "vitest";
import { validateTemplate } from "@/platform/email/render/validate";
import { renderTemplate } from "@/platform/email/render/render";
import { getDescriptor } from "@/platform/email/templates/registry";

const SCHEDULE_KEYS = [
  "schedule-swap-submitted-requester",
  "schedule-swap-submitted-partner",
  "schedule-drop-submitted-requester",
  "schedule-request-approved",
  "schedule-request-approved-partner",
  "schedule-request-denied",
  "schedule-request-cancelled-partner",
  "schedule-request-submitted-director",
] as const;

describe("schedule request templates", () => {
  it.each(SCHEDULE_KEYS)("%s is registered under the shift group", (key) => {
    const d = getDescriptor(key);
    expect(d).toBeDefined();
    expect(d!.group).toBe("shift");
  });

  it.each(SCHEDULE_KEYS)("%s subject + body only reference declared variables", (key) => {
    const d = getDescriptor(key)!;
    const allowed = d.variables.map((v) => v.name);
    expect(validateTemplate(d.defaultSubject, allowed).ok).toBe(true);
    const bodyResult = validateTemplate(d.defaultBody, allowed);
    expect(bodyResult.unknownVariables).toEqual([]);
    expect(bodyResult.ok).toBe(true);
  });

  it("director template shows the partner clause only for swaps", () => {
    const d = getDescriptor("schedule-request-submitted-director")!;
    const swap = renderTemplate(d.defaultBody, {
      directorName: "Sam",
      requesterName: "Alex Johnson",
      requestType: "swap",
      requesterDate: "July 15, 2026",
      partnerName: "Jordan",
      partnerDate: "July 22, 2026",
      departmentName: "Internal Medicine",
    });
    expect(swap).toContain("Jordan");

    const drop = renderTemplate(d.defaultBody, {
      directorName: "Sam",
      requesterName: "Alex Johnson",
      requestType: "drop",
      requesterDate: "July 15, 2026",
      partnerName: "",
      partnerDate: "",
      departmentName: "Internal Medicine",
    });
    expect(drop).not.toContain("Jordan");
  });
});
