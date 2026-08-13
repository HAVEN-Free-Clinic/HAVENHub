import { describe, expect, it } from "vitest";
import { buildShiftReminders, type ReminderAssignment } from "@/platform/email/shift-reminders";

const TARGET = new Date("2026-07-11T12:00:00.000Z"); // a Saturday, noon UTC
const BASE = "https://hub.example.org";

function person(id: string, name: string, email: string | null = `${id}@x.org`): ReminderAssignment["person"] {
  return { id, name, contactEmail: email, entraObjectId: null };
}
function row(p: ReminderAssignment["person"], code: string, deptName: string, role: ReminderAssignment["role"]): ReminderAssignment {
  return { personId: p.id, role, department: { code, name: deptName }, person: p };
}

describe("buildShiftReminders", () => {
  it("produces one reminder per scheduled person with role, department, date, links", () => {
    const vol = person("v", "Val Volunteer");
    const out = buildShiftReminders({
      assignments: [row(vol, "SCTP", "Senior Primary Care", "VOLUNTEER")],
      targetDate: TARGET,
      teamsChannelUrl: "",
      baseUrl: BASE,
      attendingName: "",
    });
    expect(out).toHaveLength(1);
    expect(out[0].context.firstName).toBe("Val");
    expect(out[0].context.roleLabel).toBe("Volunteer");
    expect(out[0].context.departmentName).toBe("Senior Primary Care");
    expect(out[0].context.clinicDateLabel).toBe("Saturday, July 11, 2026");
    expect(out[0].context.hipaaComplianceUrl).toBe(`${BASE}/my-info`);
    expect(out[0].context.shiftSwapUrl).toBe(`${BASE}/schedule`);
    expect(out[0].context.masterScheduleUrl).toBe(`${BASE}/schedule/full`);
  });

  it("derives EDs (EXEC), CAs (PCAR), and department directors on shift", () => {
    const vol = person("v", "Val Volunteer");
    const dir = person("d", "Dana Director");
    const ed = person("e", "Ed Exec");
    const ca = person("c", "Cara Advisor");
    const out = buildShiftReminders({
      assignments: [
        row(vol, "SCTP", "Senior Primary Care", "VOLUNTEER"),
        row(dir, "SCTP", "Senior Primary Care", "DIRECTOR"),
        row(ed, "EXEC", "Executive Directors", "DIRECTOR"),
        row(ca, "PCAR", "Primary Care Clinical Advisors", "DIRECTOR"),
      ],
      targetDate: TARGET,
      teamsChannelUrl: "",
      baseUrl: BASE,
      attendingName: "",
    });
    expect(out).toHaveLength(4);
    const volReminder = out.find((r) => r.person.id === "v")!;
    expect(volReminder.context.edsOnShift).toBe("Ed Exec");
    expect(volReminder.context.clinicalAdvisorsOnShift).toBe("Cara Advisor");
    expect(volReminder.context.deptDirectorsOnShift).toBe("Dana Director");
  });

  it("excludes a director from their own department-directors list", () => {
    const dir = person("d", "Dana Director");
    const out = buildShiftReminders({
      assignments: [row(dir, "SCTP", "Senior Primary Care", "DIRECTOR")],
      targetDate: TARGET,
      teamsChannelUrl: "",
      baseUrl: BASE,
      attendingName: "",
    });
    expect(out[0].context.deptDirectorsOnShift).toBe("");
  });

  it("passes through the Teams channel URL and skips nothing when it is empty", () => {
    const vol = person("v", "Val Volunteer");
    const out = buildShiftReminders({
      assignments: [row(vol, "SCTP", "Senior Primary Care", "VOLUNTEER")],
      targetDate: TARGET,
      teamsChannelUrl: "https://teams/x",
      baseUrl: BASE,
      attendingName: "",
    });
    expect(out[0].context.teamsChannelUrl).toBe("https://teams/x");
  });

  it("renders an additionalShifts block for a person with two same-day shifts", () => {
    const both = person("b", "Bo Both");
    const out = buildShiftReminders({
      assignments: [
        row(both, "SCTP", "Senior Primary Care", "VOLUNTEER"),
        row(both, "PHAM", "Pharmacy", "SHADOW"),
      ],
      targetDate: TARGET,
      teamsChannelUrl: "",
      baseUrl: BASE,
      attendingName: "",
    });
    expect(out).toHaveLength(1);
    expect(String(out[0].context.additionalShifts)).toContain("Pharmacy");
  });

  it("keeps two same-named directors distinct in deptDirectorsOnShift (identity is by id, not name)", () => {
    const dir1 = person("d1", "Sam Lee");
    const dir2 = person("d2", "Sam Lee");
    const vol = person("v", "Val Volunteer");
    const out = buildShiftReminders({
      assignments: [
        row(dir1, "SCTP", "Senior Primary Care", "DIRECTOR"),
        row(dir2, "SCTP", "Senior Primary Care", "DIRECTOR"),
        row(vol, "SCTP", "Senior Primary Care", "VOLUNTEER"),
      ],
      targetDate: TARGET,
      teamsChannelUrl: "",
      baseUrl: BASE,
      attendingName: "",
    });
    const volReminder = out.find((r) => r.person.id === "v")!;
    expect(volReminder.context.deptDirectorsOnShift).toBe("Sam Lee, Sam Lee");
  });

  it("omits the department-directors list for a director recipient but shows it to volunteers and shadows", () => {
    const dir1 = person("d1", "Dana Director");
    const dir2 = person("d2", "Devi Director");
    const vol = person("v", "Val Volunteer");
    const shadow = person("s", "Sky Shadow");
    const out = buildShiftReminders({
      assignments: [
        row(dir1, "SCTP", "Senior Primary Care", "DIRECTOR"),
        row(dir2, "SCTP", "Senior Primary Care", "DIRECTOR"),
        row(vol, "SCTP", "Senior Primary Care", "VOLUNTEER"),
        row(shadow, "SCTP", "Senior Primary Care", "SHADOW"),
      ],
      targetDate: TARGET,
      teamsChannelUrl: "",
      baseUrl: BASE,
      attendingName: "",
    });
    // A director is on shift themselves and does not need the directors list.
    expect(out.find((r) => r.person.id === "d1")!.context.deptDirectorsOnShift).toBe("");
    expect(out.find((r) => r.person.id === "d2")!.context.deptDirectorsOnShift).toBe("");
    // Volunteers and shadows still see who is leading their shift.
    expect(out.find((r) => r.person.id === "v")!.context.deptDirectorsOnShift).toBe("Dana Director, Devi Director");
    expect(out.find((r) => r.person.id === "s")!.context.deptDirectorsOnShift).toBe("Dana Director, Devi Director");
  });
});
