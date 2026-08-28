import { describe, expect, it } from "vitest";
import { validateTemplate } from "@/platform/email/render/validate";
import { renderTemplate } from "@/platform/email/render/render";
import { getDescriptor } from "@/platform/email/templates/registry";
import { shiftReminderContext, ccReminderContext, triageReminderContext } from "@/platform/email/templates/shift";

function fullContext(over: Partial<Parameters<typeof shiftReminderContext>[0]> = {}) {
  return shiftReminderContext({
    firstName: "Sam",
    roleLabel: "Volunteer",
    departmentName: "Senior Primary Care",
    clinicDateLabel: "Saturday, July 11, 2026",
    additionalShifts: "",
    closedNotice: "",
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

function ccContext(over: Partial<Parameters<typeof ccReminderContext>[0]> = {}) {
  return ccReminderContext({
    firstName: "Sam",
    clinicDateLabel: "Saturday, July 11, 2026",
    helpDeskUrl: "https://hub.example/support/new",
    ...over,
  });
}

describe("shift-reminder-cc template", () => {
  it("is registered under the shift group", () => {
    const d = getDescriptor("shift-reminder-cc");
    expect(d).toBeDefined();
    expect(d!.group).toBe("shift");
  });

  it("default subject + body only reference declared variables", () => {
    const d = getDescriptor("shift-reminder-cc")!;
    const allowed = d.variables.map((v) => v.name);
    expect(validateTemplate(d.defaultSubject, allowed).ok).toBe(true);
    const bodyResult = validateTemplate(d.defaultBody, allowed);
    expect(bodyResult.unknownVariables).toEqual([]);
    expect(bodyResult.ok).toBe(true);
  });

  it("greets the recipient and carries the CAs' dot-phrase instructions", () => {
    const d = getDescriptor("shift-reminder-cc")!;
    const html = renderTemplate(d.defaultBody, ccContext());
    expect(html).toContain("Sam");
    expect(html).toContain("smartphrase manager");
    expect(html).toContain("Tyger Lin");
    expect(html).toContain("Doximity");
    expect(html).toContain("https://hub.example/support/new");
  });

  // The drafts arrived with square-bracket placeholders the CAs filled in by
  // hand. Every one of them must have become a variable or static text; a
  // literal bracket surviving into the body means a merge field was missed.
  it("leaves no unfilled bracket placeholders", () => {
    const d = getDescriptor("shift-reminder-cc")!;
    const html = renderTemplate(d.defaultBody, ccContext());
    expect(html).not.toMatch(/\[[^\]]*\]/);
  });
});

function triageContext(over: Partial<Parameters<typeof triageReminderContext>[0]> = {}) {
  return triageReminderContext({
    firstName: "Sam",
    clinicDateLabel: "Saturday, July 11, 2026",
    edsOnShift: "Jordan Blake",
    clinicalAdvisorsOnShift: "Dr. Pat Lee",
    attendingOnShift: "Dr. Morgan Ellis",
    masterScheduleUrl: "https://hub.example/schedule/full",
    ...over,
  });
}

describe("shift-reminder-triage template", () => {
  it("is registered under the shift group", () => {
    const d = getDescriptor("shift-reminder-triage");
    expect(d).toBeDefined();
    expect(d!.group).toBe("shift");
  });

  it("default subject + body only reference declared variables", () => {
    const d = getDescriptor("shift-reminder-triage")!;
    const allowed = d.variables.map((v) => v.name);
    expect(validateTemplate(d.defaultSubject, allowed).ok).toBe(true);
    const bodyResult = validateTemplate(d.defaultBody, allowed);
    expect(bodyResult.unknownVariables).toEqual([]);
    expect(bodyResult.ok).toBe(true);
  });

  it("names the EDs, CAs and on-call attending from the schedule", () => {
    const d = getDescriptor("shift-reminder-triage")!;
    const html = renderTemplate(d.defaultBody, triageContext());
    expect(html).toContain("Sam");
    expect(html).toContain("Jordan Blake");
    expect(html).toContain("Dr. Pat Lee");
    expect(html).toContain("Dr. Morgan Ellis");
    expect(html).toContain("Triage Chat");
  });

  // An unstaffed week must not print "reach out to" followed by nothing, the
  // same rule the main reminder follows for its leadership lists.
  it("hides the leadership lines when nobody is on shift", () => {
    const d = getDescriptor("shift-reminder-triage")!;
    const html = renderTemplate(
      d.defaultBody,
      triageContext({ edsOnShift: "", clinicalAdvisorsOnShift: "", attendingOnShift: "" }),
    );
    expect(html).not.toContain("Dr. Morgan Ellis");
    expect(html).not.toContain("the on-call attending");
    expect(html).not.toMatch(/reach out to\s*[.<]/);
  });

  it("leaves no unfilled bracket placeholders", () => {
    const d = getDescriptor("shift-reminder-triage")!;
    const html = renderTemplate(d.defaultBody, triageContext());
    expect(html).not.toMatch(/\[[^\]]*\]/);
  });
});

describe("role reminder document links", () => {
  /** Every href in a template body, as written in the HTML source. */
  function hrefsIn(body: string): string[] {
    return [...body.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  }

  it("links the CC JCTM Guide", () => {
    const d = getDescriptor("shift-reminder-cc")!;
    const html = renderTemplate(d.defaultBody, ccContext());
    expect(html).toMatch(/<a href="https:\/\/yaleedu\.sharepoint\.com[^"]*CC_JCTM_Guide[^"]*"/);
  });

  it("links all five triage reference documents", () => {
    const d = getDescriptor("shift-reminder-triage")!;
    const sharepoint = hrefsIn(d.defaultBody).filter((h) => h.includes("sharepoint.com"));
    expect(sharepoint).toHaveLength(5);
  });

  // A bare "&" inside an href is the classic way a multi-parameter SharePoint
  // link dies: strict parsers and some mail clients truncate the URL at the
  // first entity-looking run, and the recipient lands on a permission error.
  it("escapes every ampersand in a document link", () => {
    for (const key of ["shift-reminder-cc", "shift-reminder-triage"]) {
      for (const href of hrefsIn(getDescriptor(key)!.defaultBody)) {
        expect(href, `${key}: ${href}`).not.toMatch(/&(?!amp;)/);
      }
    }
  });

  // The Clinical Reasoning Tool link arrived from a Teams message carrying an
  // xsdata routing blob and an ovuser naming a specific person's address.
  // Neither belongs in mail sent to volunteers.
  it("carries no tracking or personal-identity parameters", () => {
    for (const key of ["shift-reminder-cc", "shift-reminder-triage"]) {
      for (const href of hrefsIn(getDescriptor(key)!.defaultBody)) {
        expect(href, `${key}: ${href}`).not.toMatch(/xsdata=|ovuser=/);
      }
    }
  });
});
