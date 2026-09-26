import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createCycle } from "@/modules/recruitment/services/cycles";
import { addField } from "@/modules/recruitment/services/form-builder";
import { collectSchemaKeys, IDENTITY_ARGUMENT_PATTERN } from "../tools/index";
import {
  RECRUITMENT_TOOLS,
  APPLICATION_REFUSAL,
  CYCLE_REFUSAL,
  FILE_PLACEHOLDER,
  NO_RECRUITMENT_ACCESS,
} from "./tools";

/**
 * Real-DB tests. What these tools promise is "exactly what the Hub shows this
 * person", and that lives in reviewScope / manageableDepartmentIds / can() and
 * the services' own filters. Mocking any of them would test the mock.
 */

function tool(name: string) {
  const t = RECRUITMENT_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

async function run(name: string, personId: string, args: Record<string, unknown> = {}) {
  return tool(name).run({ personId }, args);
}

async function person(name: string, opts?: { netId?: string; contactEmail?: string }) {
  return prisma.person.create({ data: { name, status: "ACTIVE", netId: opts?.netId, contactEmail: opts?.contactEmail } });
}

async function grant(personId: string, roleName: string, permissions: string[]) {
  const role = await prisma.role.create({
    data: { name: roleName, grants: { create: permissions.map((permission) => ({ permission })) } },
  });
  await prisma.roleAssignment.create({ data: { personId, roleId: role.id } });
}

async function seed() {
  const term = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date(), status: "ACTIVE" },
  });
  const srhd = await prisma.department.create({ data: { code: "SRHD", name: "Student Run Health Dept" } });
  await prisma.department.create({ data: { code: "MDIC", name: "Medical Dept" } });

  // A cycle manager: recruitment.access + manage_cycles, no review_all, no score.
  const manager = await person("Manager Mo");
  await grant(manager.id, "Recruitment Manager", ["recruitment.access", "recruitment.manage_cycles"]);

  // SRR: review_all on top.
  const lead = await person("Lead Lu");
  await grant(lead.id, "Recruitment Lead", ["recruitment.access", "recruitment.manage_cycles", "recruitment.review_all"]);

  // A department director, admitted by review scope: DIRECTOR membership plus the
  // baseline kind-targeted Director role (volunteers.view), as in production.
  const director = await person("Director Di");
  const directorRole = await prisma.role.create({
    data: { name: "Director", isSystem: true, grants: { create: [{ permission: "volunteers.view" }] } },
  });
  await prisma.roleAssignment.create({ data: { roleId: directorRole.id, kind: "DIRECTOR", termId: null } });
  await prisma.termMembership.create({
    data: { personId: director.id, termId: term.id, departmentId: srhd.id, kind: "DIRECTOR", status: "ACTIVE" },
  });

  const outsider = await person("Outsider Oz");

  const cycle = await createCycle({
    track: "VOLUNTEER", termId: term.id, title: "Volunteer Fall 2026", publicSlug: "mcp-v",
    departments: ["SRHD", "MDIC"], acceptsRenewals: false, createdById: lead.id,
  });
  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { status: "OPEN" } });
  const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id }, orderBy: { order: "asc" } });
  const essay = await addField(section.id, { label: "Why HAVEN", type: "LONG_TEXT", required: false });
  const resume = await addField(section.id, { label: "Resume", type: "FILE", required: false });
  const sig = await addField(section.id, { label: "Signature", type: "SIGNATURE", required: false });

  const mkApp = async (first: string, email: string, choices: string[], extra: Record<string, unknown> = {}) => {
    const applicant = await prisma.applicant.create({
      data: { cycleId: cycle.id, firstName: first, lastName: "Applicant", email, emailLower: email.toLowerCase() },
    });
    return prisma.application.create({
      data: {
        cycleId: cycle.id, applicantId: applicant.id, applicantType: "NEW", departmentChoices: choices,
        submittedAt: new Date(),
        answers: {
          [essay.key]: `${first} essay text`,
          [resume.key]: { storedName: `secret-blob-${first}.pdf`, fileName: `${first}-resume.pdf`, mimeType: "application/pdf" },
          [sig.key]: { storedName: `secret-sig-${first}.png`, fileName: "signature.png", mimeType: "image/png" },
        },
        ...extra,
      },
    });
  };
  // Routed to the director's department.
  const routedSrhd = await mkApp("Rita", "rita@yale.edu", ["MDIC"], { routedDepartmentCode: "SRHD", routedAt: new Date() });
  // Ranked SRHD but never routed: invisible to the director.
  const unrouted = await mkApp("Uma", "uma@yale.edu", ["SRHD"]);
  // Routed elsewhere.
  const routedMdic = await mkApp("Max", "max@yale.edu", ["MDIC"], { routedDepartmentCode: "MDIC", routedAt: new Date() });

  // Committee scores with comments on the director's routed application.
  const scorerA = await person("Scorer Sam");
  await prisma.committeeScore.create({ data: { applicationId: routedSrhd.id, scorerId: scorerA.id, score: 4, comments: "SECRET-COMMENT-A" } });
  await prisma.committeeScore.create({ data: { applicationId: unrouted.id, scorerId: scorerA.id, score: 2, comments: "SECRET-COMMENT-B" } });

  return { term, manager, lead, director, outsider, cycle, routedSrhd, unrouted, routedMdic, scorerA };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("recruitment MCP tools -- identity", () => {
  it("no tool's input schema carries an identity-shaped key", () => {
    for (const t of RECRUITMENT_TOOLS) {
      const keys = collectSchemaKeys(t.inputSchema);
      for (const k of keys) expect(k, `${t.name}.${k}`).not.toMatch(IDENTITY_ARGUMENT_PATTERN);
    }
  });
});

describe("list_cycles", () => {
  it("gives a recruitment.access holder every cycle, including drafts", async () => {
    const f = await seed();
    await prisma.recruitmentCycle.create({
      data: { track: "DIRECTOR", termId: f.term.id, title: "Draft Directors", publicSlug: "mcp-d", departments: ["SRHD"], createdById: f.lead.id },
    });
    const out = JSON.parse(await run("list_cycles", f.manager.id));
    expect(out.cycles.map((c: { title: string }) => c.title).sort()).toEqual(["Draft Directors", "Volunteer Fall 2026"]);
    expect(out.cycles[0]).toHaveProperty("termName", "Fall 2026");
  });

  it("gives a scope director only cycles with something routed to them, without window fields", async () => {
    const f = await seed();
    const out = JSON.parse(await run("list_cycles", f.director.id));
    expect(out.cycles).toEqual([{ id: f.cycle.id, title: "Volunteer Fall 2026", track: "VOLUNTEER", status: "OPEN" }]);
  });

  it("refuses a person with no recruitment standing", async () => {
    const f = await seed();
    expect(await run("list_cycles", f.outsider.id)).toBe(NO_RECRUITMENT_ACCESS);
  });
});

describe("list_applicants", () => {
  it("shows a manage_cycles holder every submitted application in the cycle", async () => {
    const f = await seed();
    const out = JSON.parse(await run("list_applicants", f.manager.id, { cycle_id: f.cycle.id }));
    expect(out.total).toBe(3);
    const ids = out.rows.map((r: { applicationId: string }) => r.applicationId).sort();
    expect(ids).toEqual([f.routedSrhd.id, f.unrouted.id, f.routedMdic.id].sort());
  });

  it("shows a department director only applications routed to their department", async () => {
    const f = await seed();
    const out = JSON.parse(await run("list_applicants", f.director.id, { cycle_id: f.cycle.id }));
    expect(out.total).toBe(1);
    expect(out.rows[0].applicationId).toBe(f.routedSrhd.id);
    expect(out.rows[0].committee).toEqual({ average: 4, count: 1 });
  });

  it("refuses a person with no recruitment permissions, returning nothing else", async () => {
    const f = await seed();
    const text = await run("list_applicants", f.outsider.id, { cycle_id: f.cycle.id });
    expect(text).toBe(CYCLE_REFUSAL);
    expect(await run("cycle_summary", f.outsider.id, { cycle_id: f.cycle.id })).toBe(CYCLE_REFUSAL);
    expect(await run("list_interviews", f.outsider.id, { cycle_id: f.cycle.id })).toBe(CYCLE_REFUSAL);
    expect(await run("list_waitlist", f.outsider.id, { cycle_id: f.cycle.id })).toBe(CYCLE_REFUSAL);
    expect(await run("get_application", f.outsider.id, { application_id: f.routedSrhd.id })).toBe(APPLICATION_REFUSAL);
  });

  it("gives an unknown cycle the same refusal as a cycle the caller cannot see", async () => {
    const f = await seed();
    expect(await run("list_applicants", f.manager.id, { cycle_id: "nope" })).toBe(CYCLE_REFUSAL);
  });

  it("pages, and reports the full total", async () => {
    const f = await seed();
    const first = JSON.parse(await run("list_applicants", f.manager.id, { cycle_id: f.cycle.id, limit: 2 }));
    expect(first.total).toBe(3);
    expect(first.rows).toHaveLength(2);
    const second = JSON.parse(await run("list_applicants", f.manager.id, { cycle_id: f.cycle.id, limit: 2, offset: 2 }));
    expect(second.total).toBe(3);
    expect(second.rows).toHaveLength(1);
    expect(await run("list_applicants", f.manager.id, { cycle_id: f.cycle.id, limit: 500 })).toMatch(/not valid/);
  });

  it("filters by department the way the Hub's Department filter does", async () => {
    const f = await seed();
    const out = JSON.parse(await run("list_applicants", f.manager.id, { cycle_id: f.cycle.id, department_code: "SRHD" }));
    // Routed to SRHD, plus unrouted-but-ranked SRHD; not the one routed to MDIC.
    expect(out.rows.map((r: { applicationId: string }) => r.applicationId).sort()).toEqual([f.routedSrhd.id, f.unrouted.id].sort());
  });

  it("hides the scores on the caller's own application", async () => {
    const f = await seed();
    // The manager applied too, under their own account.
    const applicant = await prisma.applicant.create({
      data: { cycleId: f.cycle.id, firstName: "Manager", lastName: "Mo", email: "mo@yale.edu", emailLower: "mo@yale.edu", applicantPersonId: f.manager.id },
    });
    const own = await prisma.application.create({
      data: { cycleId: f.cycle.id, applicantId: applicant.id, applicantType: "NEW", departmentChoices: ["SRHD"], answers: {} },
    });
    await prisma.committeeScore.create({ data: { applicationId: own.id, scorerId: f.scorerA.id, score: 5, comments: "OWN-SECRET" } });
    const text = await run("list_applicants", f.manager.id, { cycle_id: f.cycle.id });
    const row = JSON.parse(text).rows.find((r: { applicationId: string }) => r.applicationId === own.id);
    expect(row.committee).toEqual({ hidden: "your own application" });
    expect(text).not.toContain("OWN-SECRET");

    // Also hidden on the detail read, even for a lead who would otherwise see every score.
    await prisma.applicant.update({ where: { id: applicant.id }, data: { applicantPersonId: f.lead.id } });
    const detail = JSON.parse(await run("get_application", f.lead.id, { application_id: own.id }));
    expect(detail.committeeScores).toEqual({ hidden: "your own application" });
  });
});

describe("cycle_summary", () => {
  it("counts only what the caller can see", async () => {
    const f = await seed();
    const all = JSON.parse(await run("cycle_summary", f.manager.id, { cycle_id: f.cycle.id }));
    expect(all.totalSubmitted).toBe(3);
    expect(all.byRoutedDepartment).toEqual({ SRHD: 1, MDIC: 1, "(not routed)": 1 });
    expect(all.scoring.withAtLeastOneScore).toBe(2);
    const dir = JSON.parse(await run("cycle_summary", f.director.id, { cycle_id: f.cycle.id }));
    expect(dir.totalSubmitted).toBe(1);
  });
});

describe("get_application", () => {
  it("never returns a file URL or stored name, and renders files as the placeholder", async () => {
    const f = await seed();
    const text = await run("get_application", f.lead.id, { application_id: f.routedSrhd.id });
    expect(text).not.toMatch(/storedName|secret-blob|secret-sig|\/api\/recruitment|inlineHref|Rita-resume/);
    const out = JSON.parse(text);
    const fields = out.sections.flatMap((s: { fields: { label: string; value: string }[] }) => s.fields);
    expect(fields.find((x: { label: string }) => x.label === "Resume").value).toBe(FILE_PLACEHOLDER);
    expect(fields.find((x: { label: string }) => x.label === "Signature").value).toBe("Signed");
    expect(fields.find((x: { label: string }) => x.label === "Why HAVEN").value).toBe("Rita essay text");
  });

  it("returns a byte-identical refusal for an unknown id and an application the caller cannot see", async () => {
    const f = await seed();
    const unknown = await run("get_application", f.director.id, { application_id: "does-not-exist" });
    const hidden = await run("get_application", f.director.id, { application_id: f.unrouted.id });
    expect(hidden).toBe(unknown);
    expect(hidden).toBe(APPLICATION_REFUSAL);
  });

  it("hides named score comments from a manage_cycles holder but shows them to review_all", async () => {
    const f = await seed();
    const managerText = await run("get_application", f.manager.id, { application_id: f.unrouted.id });
    expect(managerText).not.toContain("SECRET-COMMENT-B");
    expect(JSON.parse(managerText).committeeScores).toBeNull();

    const leadText = await run("get_application", f.lead.id, { application_id: f.unrouted.id });
    expect(leadText).toContain("SECRET-COMMENT-B");
    expect(JSON.parse(leadText).committeeScores.scores).toEqual([{ scorer: "Scorer Sam", score: 2, comments: "SECRET-COMMENT-B" }]);
  });

  it("shows the routed department's director every score, as the deciding director", async () => {
    const f = await seed();
    const out = JSON.parse(await run("get_application", f.director.id, { application_id: f.routedSrhd.id }));
    expect(out.committeeScores.scores[0].comments).toBe("SECRET-COMMENT-A");
  });

  it("gives a plain committee scorer the average and their own score, not anyone else's comments", async () => {
    const f = await seed();
    const scorerB = await person("Scorer Bea");
    await grant(scorerB.id, "Committee Scorer", ["recruitment.score"]);
    await prisma.committeeScore.create({ data: { applicationId: f.unrouted.id, scorerId: scorerB.id, score: 4, comments: "mine" } });
    const text = await run("get_application", scorerB.id, { application_id: f.unrouted.id });
    expect(text).not.toContain("SECRET-COMMENT-B");
    expect(JSON.parse(text).committeeScores).toEqual({ average: 3, count: 2, myScore: { score: 4, comments: "mine" } });
  });

  it("writes the Hub's application_view audit row, and only after access passes", async () => {
    const f = await seed();
    await run("get_application", f.director.id, { application_id: f.unrouted.id }); // refused
    expect(await prisma.auditLog.count({ where: { action: "recruitment.application_view" } })).toBe(0);

    await run("get_application", f.manager.id, { application_id: f.routedSrhd.id });
    const rows = await prisma.auditLog.findMany({ where: { action: "recruitment.application_view" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorPersonId: f.manager.id, entityType: "Application", entityId: f.routedSrhd.id });
  });

  it("refuses a draft application", async () => {
    const f = await seed();
    await prisma.application.update({ where: { id: f.unrouted.id }, data: { status: "DRAFT" } });
    expect(await run("get_application", f.lead.id, { application_id: f.unrouted.id })).toBe(APPLICATION_REFUSAL);
  });
});

describe("list_interviews and list_waitlist", () => {
  it("lists waitlisted applicants in scope and reports the total", async () => {
    const f = await seed();
    await prisma.application.update({ where: { id: f.routedMdic.id }, data: { decision: "WAITLIST" } });
    const out = JSON.parse(await run("list_waitlist", f.manager.id, { cycle_id: f.cycle.id }));
    expect(out.total).toBe(1);
    expect(out.rows[0]).toMatchObject({ applicationId: f.routedMdic.id, departmentCode: "MDIC", acceptedElsewhere: null });
    expect(out).toMatchObject({ applications: 1, acceptedElsewhere: 0 });
  });

  it("flags an applicant waitlisted by one department but accepted by another, which cycle_summary counts as accepted", async () => {
    // The Fall 2026 shape: routed to and waitlisted by one department, accepted
    // into another through a dual appointment. Both tools are right by their own
    // page's definition; the flag is what lets a reader reconcile them.
    const f = await seed();
    await prisma.application.update({ where: { id: f.routedMdic.id }, data: { decision: "WAITLIST" } });
    await prisma.acceptance.create({ data: { applicationId: f.routedMdic.id, departmentCode: "SRHD", approvedById: f.lead.id } });

    const waitlist = JSON.parse(await run("list_waitlist", f.manager.id, { cycle_id: f.cycle.id }));
    expect(waitlist).toMatchObject({ total: 1, applications: 1, acceptedElsewhere: 1 });
    expect(waitlist.rows[0]).toMatchObject({ departmentCode: "MDIC", acceptedElsewhere: ["SRHD"] });

    const summary = JSON.parse(await run("cycle_summary", f.manager.id, { cycle_id: f.cycle.id }));
    expect(summary.byDecision.WAITLIST ?? 0).toBe(0);
    expect(summary.byDecision.ACCEPTED).toBe(1);
  });

  it("lists interviews with evaluations but never the Zoom link or internal notes", async () => {
    const f = await seed();
    const iv = await prisma.interview.create({
      data: {
        applicationId: f.routedSrhd.id, departmentCode: "SRHD", createdById: f.lead.id,
        zoomLink: "https://zoom.example/SECRET", notes: "INTERNAL-NOTE", applicantNote: "APPLICANT-NOTE",
      },
    });
    await prisma.interviewPanelist.create({ data: { interviewId: iv.id, personId: f.scorerA.id, isLead: true } });
    await prisma.evaluation.create({ data: { interviewId: iv.id, evaluatorId: f.scorerA.id, score: 5, comments: "great" } });
    const text = await run("list_interviews", f.manager.id, { cycle_id: f.cycle.id });
    expect(text).not.toMatch(/SECRET|INTERNAL-NOTE|APPLICANT-NOTE/);
    const out = JSON.parse(text);
    expect(out.total).toBe(1);
    expect(out.rows[0]).toMatchObject({ status: "Offered", panelists: 1, evaluationsDone: 1, evaluations: [{ evaluator: "Scorer Sam", score: 5, comments: "great" }] });
  });
});
