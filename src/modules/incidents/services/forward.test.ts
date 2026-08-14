/**
 * TDD tests for forwarding an incident report, or an issued strike, to a
 * clinical supervisor outside the Hub.
 *
 * This replaces a blind copy. Before it, every non-anonymous report and every
 * non-confidential strike was emailed to EVERY address in
 * incidents.externalEscalationEmails, automatically, with nobody deciding.
 * Forwarding is now a reviewer's deliberate act, one recipient set at a time,
 * and each one leaves a record on the report or strike it disclosed.
 *
 * forwardReport(actorPersonId, reportId, { emails, note }):
 *   - Non-manager -> IncidentForbiddenError.
 *   - Missing report -> IncidentNotFoundError.
 *   - Writes one IncidentForward row per recipient, stamped with the actor.
 *   - Queues one email per recipient.
 *   - Rejects an address that is not in the configured directory.
 *   - Rejects an empty recipient list.
 *
 * listForwards(reportId):
 *   - Returns the trail newest-first for rendering on the report.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { submitReport, IncidentNotFoundError, IncidentForbiddenError } from "./report";
import { issueAction } from "./disciplinary";
import {
  forwardReport,
  forwardStrike,
  listReportForwards,
  recentForwardEmails,
  IncidentForwardError,
} from "./forward";


async function createPerson(name: string, netId?: string) {
  return prisma.person.create({ data: { name, netId } });
}

async function grantPermission(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: {
      name: `Role-${permission}-${Date.now()}-${Math.random()}`,
      grants: { create: [{ permission }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

async function aReport(reporterId: string) {
  return submitReport(reporterId, {
    concernTypes: ["PROFESSIONAL_CONDUCT"],
    description: "Something happened.",
  });
}

beforeEach(resetDb);

describe("forwardReport", () => {
  it("refuses a non-manager", async () => {
    const reporter = await createPerson("Reporter");
    const nosy = await createPerson("Nosy");
    const report = await aReport(reporter.id);
    await expect(
      forwardReport(nosy.id, report.id, { emails: ["advisor@ynhh.org"] })
    ).rejects.toThrow(IncidentForbiddenError);
  });

  it("refuses a missing report", async () => {
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "incidents.manage");
    await expect(
      forwardReport(mgr.id, "no-such-report", { emails: ["advisor@ynhh.org"] })
    ).rejects.toThrow(IncidentNotFoundError);
  });

  it("records one forward per recipient, stamped with the forwarding reviewer", async () => {
    const reporter = await createPerson("Reporter");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "incidents.manage");
    const report = await aReport(reporter.id);

    await forwardReport(mgr.id, report.id, {
      emails: ["advisor@ynhh.org", "second@ynhh.org"],
      note: "Please review before Saturday.",
    });

    const rows = await prisma.incidentForward.findMany({
      where: { reportId: report.id },
      orderBy: { toEmail: "asc" },
    });
    expect(rows.map((r) => r.toEmail)).toEqual(["advisor@ynhh.org", "second@ynhh.org"]);
    expect(rows.every((r) => r.forwardedById === mgr.id)).toBe(true);
    expect(rows.every((r) => r.note === "Please review before Saturday.")).toBe(true);
  });

  it("queues one email per recipient", async () => {
    const reporter = await createPerson("Reporter");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "incidents.manage");
    const report = await aReport(reporter.id);

    await forwardReport(mgr.id, report.id, { emails: ["advisor@ynhh.org"] });

    const mail = await prisma.emailLog.findMany({ where: { toEmail: "advisor@ynhh.org" } });
    expect(mail).toHaveLength(1);
  });

  it("accepts any address the reviewer types", async () => {
    // External advisors have no Hub account and no Person record, so there is
    // nothing to pre-register them against. A reviewer types the address of
    // whichever advisor this matter should reach.
    const reporter = await createPerson("Reporter");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "incidents.manage");
    const report = await aReport(reporter.id);

    await forwardReport(mgr.id, report.id, { emails: ["advisor@ynhh.org"] });

    const rows = await prisma.incidentForward.findMany({ where: { reportId: report.id } });
    expect(rows.map((r) => r.toEmail)).toEqual(["advisor@ynhh.org"]);
  });

  it("still refuses something that is not an email address", async () => {
    // The only guard left. A typo that is not an address would fail silently at
    // send time, leaving a forward row claiming a disclosure that never happened.
    const reporter = await createPerson("Reporter");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "incidents.manage");
    const report = await aReport(reporter.id);

    await expect(
      forwardReport(mgr.id, report.id, { emails: ["not-an-email"] })
    ).rejects.toThrow(IncidentForwardError);
    expect(await prisma.incidentForward.count()).toBe(0);
  });

  it("refuses an empty recipient list", async () => {
    const reporter = await createPerson("Reporter");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "incidents.manage");
    const report = await aReport(reporter.id);
    await expect(forwardReport(mgr.id, report.id, { emails: [] })).rejects.toThrow(
      IncidentForwardError
    );
  });

  it("forwards an anonymous report without naming the reporter", async () => {
    // Anonymity is a promise toward the SUBJECT, and the external email carries
    // only the report number, concern types, and risk flag -- never the
    // reporter, the description, or a link. So an anonymous report is
    // forwardable; what protects the reporter is the payload, not a blanket ban.
    const reporter = await createPerson("Anonymous Reporter");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "incidents.manage");
    const report = await submitReport(reporter.id, {
      concernTypes: ["PROFESSIONAL_CONDUCT"],
      description: "Something happened.",
      anonymous: true,
    });

    await forwardReport(mgr.id, report.id, { emails: ["advisor@ynhh.org"] });

    const mail = await prisma.emailLog.findFirstOrThrow({ where: { toEmail: "advisor@ynhh.org" } });
    expect(mail.html).not.toContain("Anonymous Reporter");
    expect(mail.html).not.toContain("Something happened.");
  });
});

describe("forwardStrike", () => {
  async function aStrike(actorId: string, subjectId: string, confidential = false) {
    return issueAction(actorId, {
      personId: subjectId,
      occurredAt: new Date("2026-07-01"),
      category: "Attendance",
      description: "No-show to an assigned clinic shift.",
      confidential,
    });
  }

  it("records the forward against the strike and emails the recipient", async () => {
    const mgr = await createPerson("Manager");
    const subject = await createPerson("Subject");
    await grantPermission(mgr.id, "incidents.manage");
    const action = await aStrike(mgr.id, subject.id);

    await forwardStrike(mgr.id, action.id, { emails: ["advisor@ynhh.org"] });

    const rows = await prisma.incidentForward.findMany({ where: { actionId: action.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].reportId).toBeNull();
    expect(await prisma.emailLog.count({ where: { toEmail: "advisor@ynhh.org" } })).toBe(1);
  });

  it("refuses to forward a CONFIDENTIAL strike", async () => {
    // A confidential strike comes from an anonymous report (decideStrike sets
    // confidential from report.anonymous). Not even its own directors are told
    // about it in-app, so sending it outside the clinic would widen the audience
    // for an anonymous report past every internal rule that protects it.
    const mgr = await createPerson("Manager");
    const subject = await createPerson("Subject");
    await grantPermission(mgr.id, "incidents.manage");
    const action = await aStrike(mgr.id, subject.id, true);

    await expect(
      forwardStrike(mgr.id, action.id, { emails: ["advisor@ynhh.org"] })
    ).rejects.toThrow(IncidentForwardError);
    expect(await prisma.incidentForward.count()).toBe(0);
  });

  it("refuses a non-manager", async () => {
    const mgr = await createPerson("Manager");
    const nosy = await createPerson("Nosy");
    const subject = await createPerson("Subject");
    await grantPermission(mgr.id, "incidents.manage");
    const action = await aStrike(mgr.id, subject.id);
    await expect(
      forwardStrike(nosy.id, action.id, { emails: ["advisor@ynhh.org"] })
    ).rejects.toThrow(IncidentForbiddenError);
  });
});

describe("listReportForwards", () => {
  it("returns the trail newest first", async () => {
    const reporter = await createPerson("Reporter");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "incidents.manage");
    const report = await aReport(reporter.id);

    await forwardReport(mgr.id, report.id, { emails: ["advisor@ynhh.org"] });
    await new Promise((r) => setTimeout(r, 5));
    await forwardReport(mgr.id, report.id, { emails: ["second@ynhh.org"] });

    const trail = await listReportForwards(report.id);
    expect(trail.map((f) => f.toEmail)).toEqual(["second@ynhh.org", "advisor@ynhh.org"]);
    expect(trail[0].forwardedBy.name).toBe("Manager");
  });
});

describe("recentForwardEmails", () => {
  it("offers previously used addresses, most recent first, deduped", async () => {
    // Typing a medical advisor's address from memory every time invites a typo
    // that silently sends an incident report to a stranger. Past addresses are
    // offered as suggestions -- not as a constraint.
    const reporter = await createPerson("Reporter");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "incidents.manage");
    const report = await aReport(reporter.id);

    await forwardReport(mgr.id, report.id, { emails: ["first@ynhh.org"] });
    await new Promise((r) => setTimeout(r, 5));
    await forwardReport(mgr.id, report.id, { emails: ["second@ynhh.org"] });
    await new Promise((r) => setTimeout(r, 5));
    await forwardReport(mgr.id, report.id, { emails: ["first@ynhh.org"] });

    expect(await recentForwardEmails()).toEqual(["first@ynhh.org", "second@ynhh.org"]);
  });

  it("is empty when nothing has ever been forwarded", async () => {
    expect(await recentForwardEmails()).toEqual([]);
  });
});
