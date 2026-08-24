import { describe, expect, it } from "vitest";
import { buildRoleReminders, ROLE_REMINDERS, type ReminderAssignment } from "@/platform/email/shift-reminders";

const TARGET = new Date("2026-07-11T12:00:00.000Z"); // a Saturday, noon UTC
const BASE = "https://hub.example.org";

function person(id: string, name: string, email: string | null = `${id}@x.org`): ReminderAssignment["person"] {
  return { id, name, contactEmail: email, entraObjectId: null };
}

function row(
  p: ReminderAssignment["person"],
  code: string,
  deptName: string,
  role: ReminderAssignment["role"],
  tags: Partial<ReminderAssignment["tags"]> = {},
): ReminderAssignment {
  return {
    personId: p.id,
    role,
    tags: { cc: false, triage: false, ...tags },
    department: { id: `dept-${code}`, code, name: deptName },
    person: p,
  };
}

function build(assignments: ReminderAssignment[], attendingNamesByDepartmentId: Record<string, string> = {}) {
  return buildRoleReminders({
    assignments,
    targetDate: TARGET,
    teamsChannelUrl: "",
    baseUrl: BASE,
    attendingNamesByDepartmentId,
  });
}

describe("ROLE_REMINDERS", () => {
  // The tags exist on ShiftAssignment for every med-team role, but ops asked
  // for these two only. Pinned so a stray addition is a deliberate decision
  // rather than a surprise Monday email to people who never agreed to one.
  it("covers the cc JCTM and Triage SCTM roles only", () => {
    expect(ROLE_REMINDERS.map((s) => `${s.deptCode}.${s.tag}`).sort()).toEqual(["JCTP.cc", "SCTP.triage"]);
  });

  it("keys each spec on a distinct template so dedup claims cannot collide", () => {
    const keys = ROLE_REMINDERS.map((s) => s.templateKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("buildRoleReminders", () => {
  it("prepares a cc reminder for the JCTP assignment tagged cc", () => {
    const ccPerson = person("c", "Casey Coordinator");
    const out = build([row(ccPerson, "JCTP", "Junior Primary Care", "VOLUNTEER", { cc: true })]);
    expect(out).toHaveLength(1);
    expect(out[0].person.id).toBe("c");
    expect(out[0].spec.templateKey).toBe("shift-reminder-cc");
    expect(out[0].context.firstName).toBe("Casey");
    expect(out[0].context.clinicDateLabel).toBe("Saturday, July 11, 2026");
    expect(out[0].context.helpDeskUrl).toBe(`${BASE}/support/new`);
  });

  it("prepares a triage reminder for the SCTP assignment tagged triage", () => {
    const triagePerson = person("t", "Tal Triage");
    const out = build([row(triagePerson, "SCTP", "Senior Primary Care", "VOLUNTEER", { triage: true })]);
    expect(out).toHaveLength(1);
    expect(out[0].spec.templateKey).toBe("shift-reminder-triage");
    expect(out[0].context.firstName).toBe("Tal");
    expect(out[0].context.masterScheduleUrl).toBe(`${BASE}/schedule/full`);
  });

  it("sends nothing when nobody carries a tagged role", () => {
    expect(build([row(person("v", "Val Volunteer"), "SCTP", "Senior Primary Care", "VOLUNTEER")])).toEqual([]);
  });

  // The tag and the department must BOTH match. rolesForDept scopes cc to JCTP
  // and triage to SCTP, so a tag set on a department that does not use it is
  // stale data, not a recipient.
  it("ignores a tag set on a department that does not use it", () => {
    const out = build([
      row(person("a", "Ada Mismatch"), "SCTP", "Senior Primary Care", "VOLUNTEER", { cc: true }),
      row(person("b", "Bo Mismatch"), "JCTP", "Junior Primary Care", "VOLUNTEER", { triage: true }),
    ]);
    expect(out).toEqual([]);
  });

  it("fills EDs, Clinical Advisors and the attending covering the triage department", () => {
    const triagePerson = person("t", "Tal Triage");
    const out = build(
      [
        row(triagePerson, "SCTP", "Senior Primary Care", "VOLUNTEER", { triage: true }),
        row(person("e", "Ed Exec"), "EXEC", "Executive Directors", "DIRECTOR"),
        row(person("e2", "Erin Exec"), "EXEC", "Executive Directors", "DIRECTOR"),
        row(person("c", "Cara Advisor"), "PCAR", "Primary Care Clinical Advisors", "DIRECTOR"),
      ],
      { "dept-SCTP": "Dr. Morgan Ellis (9am-12pm)" },
    );
    expect(out[0].context.edsOnShift).toBe("Ed Exec, Erin Exec");
    expect(out[0].context.clinicalAdvisorsOnShift).toBe("Cara Advisor");
    expect(out[0].context.attendingOnShift).toBe("Dr. Morgan Ellis (9am-12pm)");
  });

  // An unstaffed slot must reach the template as "" so its {{#if}} hides the
  // line, exactly as the main reminder does. Never a dangling label.
  it("leaves leadership values empty rather than absent when nobody is on shift", () => {
    const out = build([row(person("t", "Tal Triage"), "SCTP", "Senior Primary Care", "VOLUNTEER", { triage: true })]);
    expect(out[0].context.edsOnShift).toBe("");
    expect(out[0].context.clinicalAdvisorsOnShift).toBe("");
    expect(out[0].context.attendingOnShift).toBe("");
  });

  it("prepares one reminder per tagged person when a role is doubled up", () => {
    const out = build([
      row(person("t1", "Tal Triage"), "SCTP", "Senior Primary Care", "VOLUNTEER", { triage: true }),
      row(person("t2", "Tam Triage"), "SCTP", "Senior Primary Care", "VOLUNTEER", { triage: true }),
    ]);
    expect(out.map((r) => r.person.id).sort()).toEqual(["t1", "t2"]);
  });

  // One person can hold both posts across their two shifts. Each is its own
  // email with its own claim, so neither suppresses the other.
  it("prepares both reminders for one person holding both roles", () => {
    const both = person("b", "Bailey Both");
    const out = build([
      row(both, "SCTP", "Senior Primary Care", "VOLUNTEER", { triage: true }),
      row(both, "JCTP", "Junior Primary Care", "VOLUNTEER", { cc: true }),
    ]);
    expect(out.map((r) => r.spec.templateKey).sort()).toEqual(["shift-reminder-cc", "shift-reminder-triage"]);
  });

  it("carries a Teams summary naming the role", () => {
    const out = build([row(person("t", "Tal Triage"), "SCTP", "Senior Primary Care", "VOLUNTEER", { triage: true })]);
    expect(out[0].teamsSummary).toContain("Triage SCTM");
  });
});
