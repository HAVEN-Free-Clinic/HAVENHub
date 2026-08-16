/**
 * Unit tests for resolveReportAccess, the single copy of "who may see this
 * incident report, and with what powers".
 *
 * Pure and DB-free on purpose: this rule decides whether the person a report is
 * ABOUT can read it, so every branch should be reachable without seeding RBAC,
 * memberships, and a term first. The integration-level consequences (getReport
 * 404s, listMessages throwing) are covered in report.test.ts and messages.test.ts;
 * what is checked here is the decision itself.
 */

import { describe, expect, it } from "vitest";
import { resolveReportAccess } from "./report-access";

const REPORTER = "person-reporter";
const REVIEWER = "person-reviewer";
const SUBJECT = "person-subject";
const STRANGER = "person-stranger";

/** A report filed by REPORTER naming SUBJECT. */
const report = { reporterId: REPORTER, subjects: [{ personId: SUBJECT }] };

describe("resolveReportAccess", () => {
  it("denies someone who is neither the reporter nor a manager", () => {
    expect(resolveReportAccess(report, STRANGER, false)).toBeNull();
  });

  it("lets the reporter read their own report without manage powers", () => {
    expect(resolveReportAccess(report, REPORTER, false)).toEqual({
      isOwner: true,
      effectiveManage: false,
    });
  });

  it("gives a reviewer who is not a subject full manage powers", () => {
    expect(resolveReportAccess(report, REVIEWER, true)).toEqual({
      isOwner: false,
      effectiveManage: true,
    });
  });

  // The exclusion the whole module exists for: holding incidents.manage must
  // never become a way to read a report about yourself.
  it("denies a subject entirely, even holding incidents.manage", () => {
    expect(resolveReportAccess(report, SUBJECT, true)).toBeNull();
  });

  // Someone can file a report that also names them. They keep the owner's read,
  // and lose manage: reviewReport and decideStrike reject a subject server-side,
  // so manage here would only leak reviewNotes and render controls that fail.
  it("keeps the owner read but strips manage when the reporter is also a subject", () => {
    const selfNamed = { reporterId: REPORTER, subjects: [{ personId: REPORTER }] };
    expect(resolveReportAccess(selfNamed, REPORTER, true)).toEqual({
      isOwner: true,
      effectiveManage: false,
    });
  });

  it("gives a reviewer manage on a report with no linked subjects", () => {
    const noSubjects = { reporterId: REPORTER, subjects: [] };
    expect(resolveReportAccess(noSubjects, REVIEWER, true)).toEqual({
      isOwner: false,
      effectiveManage: true,
    });
  });
});
