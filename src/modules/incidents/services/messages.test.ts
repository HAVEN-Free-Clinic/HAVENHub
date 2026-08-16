/**
 * Tests for the incident-report clarification thread (services/messages.ts).
 *
 * listMessages(actor, reportId):
 *   - Missing report -> IncidentNotFoundError.
 *   - Stranger (no manage, not the reporter) -> IncidentForbiddenError.
 *   - A linked SUBJECT holding incidents.manage -> IncidentForbiddenError.
 *   - Reporter and non-subject reviewer both read the thread, oldest first,
 *     with fromReporter derived from the author.
 *
 * postReviewerQuestion(actor, reportId, body):
 *   - Moves the report to AWAITING_INFO and records the message.
 *   - A linked subject holding incidents.manage -> IncidentForbiddenError.
 *   - The reporter themselves -> IncidentValidationError.
 *   - A RESOLVED report -> IncidentValidationError, status untouched.
 *   - Blank / over-long body -> IncidentValidationError.
 *   - Notifies the reporter WITHOUT putting the question in the notification.
 *
 * postReporterMessage(actor, reportId, body):
 *   - AWAITING_INFO -> UNDER_REVIEW.
 *   - A RESOLVED report records the message without reopening it.
 *   - Non-owner -> IncidentForbiddenError.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { listMessages, postReviewerQuestion, postReporterMessage } from "./messages";
import {
  submitReport,
  IncidentNotFoundError,
  IncidentForbiddenError,
  IncidentValidationError,
} from "./report";

// ---------------------------------------------------------------------------
// Helpers (mirror report.test.ts)
// ---------------------------------------------------------------------------

/**
 * contactEmail is not decoration here: notify() silently queues nothing for a
 * person without one, so the "notification carries no case detail" tests would
 * pass vacuously against an empty EmailLog if these people had no address.
 */
async function createPerson(name: string) {
  const contactEmail = `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.test`;
  return prisma.person.create({ data: { name, contactEmail } });
}

async function grantPermission(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: {
      name: `Role-${permission}-${personId}`,
      isSystem: false,
      grants: { create: [{ permission }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

/** A plain report filed by `reporterId`, optionally naming `subjectIds`. */
async function fileReport(reporterId: string, subjectIds: string[] = []) {
  return submitReport(reporterId, {
    concernTypes: ["PATIENT_SAFETY"],
    description: "Something happened.",
    subjects: subjectIds.map((personId) => ({ personId })),
  });
}

describe("incident report clarification thread", () => {
  let reporter: { id: string };
  let reviewer: { id: string };
  let subject: { id: string };
  let stranger: { id: string };

  beforeEach(async () => {
    await resetDb();
    reporter = await createPerson("Rae Reporter");
    reviewer = await createPerson("Val Reviewer");
    subject = await createPerson("Sam Subject");
    stranger = await createPerson("Nobody Inparticular");
    await grantPermission(reviewer.id, "incidents.manage");
  });

  // -------------------------------------------------------------------------
  // listMessages
  // -------------------------------------------------------------------------

  describe("listMessages", () => {
    it("throws IncidentNotFoundError for a report that does not exist", async () => {
      await expect(listMessages(reviewer.id, "no-such-report")).rejects.toBeInstanceOf(
        IncidentNotFoundError
      );
    });

    it("throws IncidentForbiddenError for someone with no claim on the report", async () => {
      const report = await fileReport(reporter.id);
      await expect(listMessages(stranger.id, report.id)).rejects.toBeInstanceOf(
        IncidentForbiddenError
      );
    });

    // The confidentiality guarantee this feature turns on: the person a report
    // names must not read the reviewer/reporter exchange about them, and holding
    // incidents.manage must not be the loophole.
    it("throws IncidentForbiddenError for a linked subject who holds incidents.manage", async () => {
      const report = await fileReport(reporter.id, [subject.id]);
      await grantPermission(subject.id, "incidents.manage");

      await expect(listMessages(subject.id, report.id)).rejects.toBeInstanceOf(
        IncidentForbiddenError
      );
    });

    it("returns the thread oldest first, flagging which side each message came from", async () => {
      const report = await fileReport(reporter.id, [subject.id]);
      await postReviewerQuestion(reviewer.id, report.id, "Which room was this in?");
      await postReporterMessage(reporter.id, report.id, "Exam room 3.");

      const asReviewer = await listMessages(reviewer.id, report.id);
      expect(asReviewer.map((m) => [m.body, m.fromReporter, m.authorName])).toEqual([
        ["Which room was this in?", false, "Val Reviewer"],
        ["Exam room 3.", true, "Rae Reporter"],
      ]);

      // The reporter sees exactly the same thread -- nothing here is one-sided.
      const asReporter = await listMessages(reporter.id, report.id);
      expect(asReporter.map((m) => m.body)).toEqual(asReviewer.map((m) => m.body));
    });
  });

  // -------------------------------------------------------------------------
  // postReviewerQuestion
  // -------------------------------------------------------------------------

  describe("postReviewerQuestion", () => {
    it("records the question and moves the report to AWAITING_INFO", async () => {
      const report = await fileReport(reporter.id);

      await postReviewerQuestion(reviewer.id, report.id, "  Which room?  ");

      const after = await prisma.incidentReport.findUniqueOrThrow({ where: { id: report.id } });
      expect(after.status).toBe("AWAITING_INFO");

      const messages = await prisma.incidentReportMessage.findMany({ where: { reportId: report.id } });
      expect(messages).toHaveLength(1);
      expect(messages[0].body).toBe("Which room?"); // trimmed
      expect(messages[0].authorId).toBe(reviewer.id);

      const audit = await prisma.auditLog.findFirst({
        where: { action: "incident.info_requested", entityId: report.id },
      });
      expect(audit).not.toBeNull();
    });

    it("throws IncidentForbiddenError for a linked subject who holds incidents.manage", async () => {
      const report = await fileReport(reporter.id, [subject.id]);
      await grantPermission(subject.id, "incidents.manage");

      await expect(
        postReviewerQuestion(subject.id, report.id, "Was it really me?")
      ).rejects.toBeInstanceOf(IncidentForbiddenError);
      expect(await prisma.incidentReportMessage.count()).toBe(0);
    });

    it("throws IncidentForbiddenError for a reviewer without incidents.manage", async () => {
      const report = await fileReport(reporter.id);
      await expect(
        postReviewerQuestion(stranger.id, report.id, "Tell me more.")
      ).rejects.toBeInstanceOf(IncidentForbiddenError);
    });

    it("refuses to let the reporter interview themselves", async () => {
      await grantPermission(reporter.id, "incidents.manage");
      const report = await fileReport(reporter.id);

      await expect(
        postReviewerQuestion(reporter.id, report.id, "What did I mean by this?")
      ).rejects.toBeInstanceOf(IncidentValidationError);
    });

    // Asking a question must not quietly reopen a matter somebody closed.
    it("refuses on a closed report and leaves the status alone", async () => {
      const report = await fileReport(reporter.id);
      await prisma.incidentReport.update({
        where: { id: report.id },
        data: { status: "RESOLVED" },
      });

      await expect(
        postReviewerQuestion(reviewer.id, report.id, "One more thing.")
      ).rejects.toBeInstanceOf(IncidentValidationError);

      const after = await prisma.incidentReport.findUniqueOrThrow({ where: { id: report.id } });
      expect(after.status).toBe("RESOLVED");
      expect(await prisma.incidentReportMessage.count()).toBe(0);
    });

    it("rejects a blank body and an over-long one", async () => {
      const report = await fileReport(reporter.id);
      await expect(postReviewerQuestion(reviewer.id, report.id, "   ")).rejects.toBeInstanceOf(
        IncidentValidationError
      );
      await expect(
        postReviewerQuestion(reviewer.id, report.id, "x".repeat(5001))
      ).rejects.toBeInstanceOf(IncidentValidationError);
      expect(await prisma.incidentReportMessage.count()).toBe(0);
    });

    // The design decision the templates encode: the notification moves somebody
    // to a page, it does not carry case content out of the app. This test is the
    // guard -- it fails the moment anyone adds the body to the email, the Teams
    // card, or the in-app inbox row.
    it("notifies the reporter without repeating the question anywhere", async () => {
      const report = await fileReport(reporter.id);
      const secret = "Did the patient mention the medication by name";

      await postReviewerQuestion(reviewer.id, report.id, secret);

      const emails = await prisma.emailLog.findMany({ where: { template: "incidents.info_requested" } });
      expect(emails.length).toBeGreaterThan(0);
      expect(emails.every((e) => e.personId === reporter.id)).toBe(true);
      for (const email of emails) {
        expect(email.subject).not.toContain(secret);
        expect(email.html).not.toContain(secret);
      }

      const inbox = await prisma.notification.findMany({ where: { type: "incidents.info_requested" } });
      expect(inbox.length).toBeGreaterThan(0);
      for (const row of inbox) {
        expect(row.title).not.toContain(secret);
        expect(row.body).not.toContain(secret);
      }
    });
  });

  // -------------------------------------------------------------------------
  // postReporterMessage
  // -------------------------------------------------------------------------

  describe("postReporterMessage", () => {
    it("answers a question and returns the report to UNDER_REVIEW", async () => {
      const report = await fileReport(reporter.id);
      await postReviewerQuestion(reviewer.id, report.id, "Which room?");

      await postReporterMessage(reporter.id, report.id, "Exam room 3.");

      const after = await prisma.incidentReport.findUniqueOrThrow({ where: { id: report.id } });
      expect(after.status).toBe("UNDER_REVIEW");

      const audit = await prisma.auditLog.findFirst({
        where: { action: "incident.info_provided", entityId: report.id },
      });
      expect(audit).not.toBeNull();
    });

    // A reporter remembering a detail must not be able to reopen a decided
    // matter; the message is still worth recording.
    it("records an addition to a closed report without reopening it", async () => {
      const report = await fileReport(reporter.id);
      await prisma.incidentReport.update({
        where: { id: report.id },
        data: { status: "RESOLVED" },
      });

      await postReporterMessage(reporter.id, report.id, "One thing I forgot.");

      const after = await prisma.incidentReport.findUniqueOrThrow({ where: { id: report.id } });
      expect(after.status).toBe("RESOLVED");
      expect(await prisma.incidentReportMessage.count()).toBe(1);
    });

    it("lets the reporter add information unprompted while under review", async () => {
      const report = await fileReport(reporter.id);
      await prisma.incidentReport.update({
        where: { id: report.id },
        data: { status: "UNDER_REVIEW" },
      });

      await postReporterMessage(reporter.id, report.id, "It happened again today.");

      const after = await prisma.incidentReport.findUniqueOrThrow({ where: { id: report.id } });
      expect(after.status).toBe("UNDER_REVIEW");
      expect(await prisma.incidentReportMessage.count()).toBe(1);
    });

    it("throws IncidentForbiddenError for a reviewer trying to post as the reporter", async () => {
      const report = await fileReport(reporter.id);
      await expect(
        postReporterMessage(reviewer.id, report.id, "Speaking for them.")
      ).rejects.toBeInstanceOf(IncidentForbiddenError);
    });

    it("throws IncidentForbiddenError for a linked subject", async () => {
      const report = await fileReport(reporter.id, [subject.id]);
      await expect(
        postReporterMessage(subject.id, report.id, "Let me explain.")
      ).rejects.toBeInstanceOf(IncidentForbiddenError);
    });

    it("notifies reviewers without repeating the reporter's words", async () => {
      const report = await fileReport(reporter.id);
      const secret = "the patient was left unattended for twenty minutes";

      await postReporterMessage(reporter.id, report.id, secret);

      const emails = await prisma.emailLog.findMany({ where: { template: "incidents.info_provided" } });
      expect(emails.length).toBeGreaterThan(0);
      for (const email of emails) {
        expect(email.html).not.toContain(secret);
      }
    });

    // A subject who holds incidents.manage is in incidentAudience(), and must be
    // filtered out of it -- otherwise answering a question about them tells them
    // a report about them exists.
    it("never notifies a subject who holds incidents.manage", async () => {
      const report = await fileReport(reporter.id, [subject.id]);
      await grantPermission(subject.id, "incidents.manage");

      await postReporterMessage(reporter.id, report.id, "More detail.");

      const emails = await prisma.emailLog.findMany({ where: { template: "incidents.info_provided" } });
      expect(emails.some((e) => e.personId === subject.id)).toBe(false);
      const inbox = await prisma.notification.findMany({ where: { type: "incidents.info_provided" } });
      expect(inbox.some((n) => n.personId === subject.id)).toBe(false);
    });
  });
});
