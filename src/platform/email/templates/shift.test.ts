import { describe, expect, it } from "vitest";
import { validateTemplate } from "@/platform/email/render/validate";
import { renderTemplate } from "@/platform/email/render/render";
import { getDescriptor } from "@/platform/email/templates/registry";
import { shiftReminderContext } from "@/platform/email/templates/shift";

function fullContext(over: Partial<Parameters<typeof shiftReminderContext>[0]> = {}) {
  return shiftReminderContext({
    firstName: "Sam",
    roleLabel: "Volunteer",
    departmentName: "Senior Primary Care",
    clinicDateLabel: "Saturday, July 11, 2026",
    additionalShifts: "",
    edsOnShift: "Jordan Blake",
    deptDirectorsOnShift: "Alex Rivera",
    clinicalAdvisorsOnShift: "Dr. Pat Lee",
    attendingOnShift: "Dr. Morgan Ellis",
    teamsChannelUrl: "https://teams.example/x",
    hipaaComplianceUrl: "https://hub.example/my-info",
    helpDeskUrl: "https://hub.example/support/new",
    shiftSwapUrl: "https://hub.example/schedule",
    masterScheduleUrl: "https://hub.example/schedule/full",
    ...over,
  });
}

describe("shift-reminder template", () => {
  it("is registered under the shift group", () => {
    const d = getDescriptor("shift-reminder");
    expect(d).toBeDefined();
    expect(d!.group).toBe("shift");
  });

  it("default subject + body only reference declared variables", () => {
    const d = getDescriptor("shift-reminder")!;
    const allowed = d.variables.map((v) => v.name);
    expect(validateTemplate(d.defaultSubject, allowed).ok).toBe(true);
    const bodyResult = validateTemplate(d.defaultBody, allowed);
    expect(bodyResult.unknownVariables).toEqual([]);
    expect(bodyResult.ok).toBe(true);
  });

  it("renders leadership + Teams sections when values are present", () => {
    const d = getDescriptor("shift-reminder")!;
    const html = renderTemplate(d.defaultBody, fullContext());
    expect(html).toContain("Jordan Blake");
    expect(html).toContain("Alex Rivera");
    expect(html).toContain("Dr. Pat Lee");
    expect(html).toContain("https://teams.example/x");
    expect(html).toContain("Saturday, July 11, 2026");
  });

  // Epic problems used to be routed to a hardcoded Airtable form, so those
  // tickets never reached the Hub's own IT queue. The link is now a variable
  // built from app.baseUrl, which also means it follows the deployment instead
  // of pointing at one fixed host.
  it("sends Epic help desk tickets to the Hub, not an external form", () => {
    const d = getDescriptor("shift-reminder")!;
    const html = renderTemplate(d.defaultBody, fullContext());
    expect(html).toContain("https://hub.example/support/new");
    expect(html).not.toContain("airtable.com");
  });

  it("no longer describes itself as a summer pilot", () => {
    const d = getDescriptor("shift-reminder")!;
    expect(d.defaultBody).not.toContain("piloting");
  });

  it("names the attending on shift", () => {
    const d = getDescriptor("shift-reminder")!;
    const html = renderTemplate(d.defaultBody, fullContext());
    expect(html).toContain("Attending on shift");
    expect(html).toContain("Dr. Morgan Ellis");
  });

  it("hides leadership + Teams sections when values are empty", () => {
    const d = getDescriptor("shift-reminder")!;
    const html = renderTemplate(
      d.defaultBody,
      fullContext({
        edsOnShift: "",
        deptDirectorsOnShift: "",
        clinicalAdvisorsOnShift: "",
        attendingOnShift: "",
        teamsChannelUrl: "",
      }),
    );
    expect(html).not.toContain("Clinical Advisor(s) on shift");
    expect(html).not.toContain("Teams channel");
    // A clinic date with no attending assigned must print no line at all,
    // rather than a dangling "Attending on shift:" with nothing after it.
    expect(html).not.toContain("Attending on shift");
  });
});
