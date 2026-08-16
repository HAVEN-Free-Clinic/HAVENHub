import { describe, expect, it } from "vitest";
import { renderTemplate } from "@/platform/email/render/render";
import { getDescriptor } from "@/platform/email/templates/registry";
import { scheduleDescriptors } from "@/platform/email/templates/schedule";

// Derived from the descriptors, not retyped (audit 14, TSI-05). The hand-written
// list this replaces had drifted: it omitted schedule-request-denied-partner, so
// that template's group and (then) its variable guard silently ran on nothing.
// The registry-wide variable guard now lives in registry.test.ts and covers all
// 46 descriptors; what stays here is the schedule-specific behaviour.
const SCHEDULE_KEYS = scheduleDescriptors.map((d) => d.key);

describe("schedule request templates", () => {
  it("covers every schedule descriptor", () => {
    // Guards the derivation itself: an empty export would make each case vacuous.
    expect(SCHEDULE_KEYS.length).toBeGreaterThanOrEqual(10);
  });

  it.each(SCHEDULE_KEYS)("%s is registered under the shift group", (key) => {
    const d = getDescriptor(key);
    expect(d).toBeDefined();
    expect(d!.group).toBe("shift");
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
