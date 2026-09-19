/**
 * Tests for compliance email templates via renderEmail.
 *
 * These tests verify the behavioral contracts (subject, HTML shape, HTML
 * escaping, status branches) previously tested against the old
 * complianceReminderEmail function.
 *
 * The golden-master (byte-exact) assertions live in compliance.golden.test.ts.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { renderEmail } from "./renderEmail";
import {
  complianceReminderContext,
  complianceDateReviewContext,
  complianceCertRejectedContext,
  type ComplianceReminderParams,
  type ComplianceDateReviewParams,
} from "./compliance";

beforeEach(resetDb);

// ---------------------------------------------------------------------------
// compliance-reminder
// ---------------------------------------------------------------------------

describe("compliance-reminder via renderEmail", () => {
  // Actionable statuses link the member into HAVEN Hub (/my-info) via an inline
  // link + a brand-colored CTA button.
  const APP_URL = "https://hub.example.org";
  const BRAND = "#00356b";
  const CTA_URL = `${APP_URL}/my-info`;

  it("subject is exactly '[HAVEN] HIPAA certification reminder'", async () => {
    const params: ComplianceReminderParams = {
      personName: "Alice Smith",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-07-04T00:00:00Z"),
    };
    const { subject } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(subject).toBe("[HAVEN] HIPAA certification reminder");
  });

  it("EXPIRING_SOON: html contains the word 'expires'", async () => {
    const params: ComplianceReminderParams = {
      personName: "Alice Smith",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-07-04T00:00:00Z"),
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).toContain("expires");
  });

  it("EXPIRING_SOON: html contains the formatted expiry date", async () => {
    const params: ComplianceReminderParams = {
      personName: "Alice Smith",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-07-04T00:00:00Z"),
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    // Expect "July 4, 2026" (UTC)
    expect(html).toContain("July 4, 2026");
  });

  it("EXPIRED: html contains the word 'expired'", async () => {
    const params: ComplianceReminderParams = {
      personName: "Bob Jones",
      status: "EXPIRED",
      expiresAt: new Date("2025-01-15T00:00:00Z"),
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).toContain("expired");
  });

  it("EXPIRED: html contains the formatted expiry date", async () => {
    const params: ComplianceReminderParams = {
      personName: "Bob Jones",
      status: "EXPIRED",
      expiresAt: new Date("2025-01-15T00:00:00Z"),
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).toContain("January 15, 2025");
  });

  it("NO_CERTIFICATE: html contains 'do not have'", async () => {
    const params: ComplianceReminderParams = {
      personName: "Carol White",
      status: "NO_CERTIFICATE",
      expiresAt: null,
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).toContain("do not have");
  });

  it("UNKNOWN_DATE: html says the certificate is on file (not 'do not have')", async () => {
    const params: ComplianceReminderParams = {
      personName: "Carol White",
      status: "UNKNOWN_DATE",
      expiresAt: null,
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).toContain("certificate is on file");
    expect(html).not.toContain("do not have");
  });

  it("UNKNOWN_DATE: html says 'No action is needed' and does not tell the member to re-upload", async () => {
    const params: ComplianceReminderParams = {
      personName: "Carol White",
      status: "UNKNOWN_DATE",
      expiresAt: null,
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).toContain("No action is needed");
    expect(html).not.toContain("upload or renew");
  });

  // The greeting reads the FIRST name now, so that is what has to reach the
  // HTML, and what has to be escaped on the way. A name is user-supplied: the
  // apply wizard takes it from anonymous applicants.
  it("greets by the name the person goes by, escaped", async () => {
    const params: ComplianceReminderParams = {
      personName: "Alice Smith",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-07-04T00:00:00Z"),
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).toContain("Hello Alice,");

    const hostile = await renderEmail(
      "compliance-reminder",
      complianceReminderContext({ ...params, personName: "<script>alert(1)</script> Smith" }),
    );
    expect(hostile.html).not.toContain("<script>alert(1)</script>");
    expect(hostile.html).toContain("&lt;script&gt;");
  });

  it("actionable status links 'HAVEN Hub' to My Info and renders a brand-colored CTA button", async () => {
    const params: ComplianceReminderParams = {
      personName: "Alice Smith",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-07-04T00:00:00Z"),
      appUrl: APP_URL,
      brandColor: BRAND,
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    // Inline link in the sentence
    expect(html).toContain(`<a href="${CTA_URL}">HAVEN Hub</a>`);
    // Brand-colored CTA button to the same place
    expect(html).toContain("Open HAVEN Hub");
    expect(html).toContain(`background-color: ${BRAND};`);
    // The old dead "in My Info" text is gone
    expect(html).not.toContain("in My Info");
  });

  it("HTML-escapes a malicious personName", async () => {
    const params: ComplianceReminderParams = {
      personName: "<script>alert(1)</script>",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-07-04T00:00:00Z"),
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("EXPIRING_SOON with null expiresAt shows 'soon'", async () => {
    const params: ComplianceReminderParams = {
      personName: "Alice Smith",
      status: "EXPIRING_SOON",
      expiresAt: null,
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).toContain("soon");
  });

  it("PENDING_VERIFICATION: html contains the awaiting-verification status line", async () => {
    const params: ComplianceReminderParams = {
      personName: "Dana Lee",
      status: "PENDING_VERIFICATION",
      expiresAt: null,
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).toContain("awaiting verification");
  });

  it("PENDING_VERIFICATION: html contains 'No action is needed' and not 'upload or renew'", async () => {
    const params: ComplianceReminderParams = {
      personName: "Dana Lee",
      status: "PENDING_VERIFICATION",
      expiresAt: null,
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).toContain("No action is needed");
    expect(html).not.toContain("upload or renew");
    // No-action statuses do not get the CTA button.
    expect(html).not.toContain("Open HAVEN Hub");
  });

  it("EXPIRED: still asks the member to upload or renew, now linked into HAVEN Hub", async () => {
    const params: ComplianceReminderParams = {
      personName: "Bob Jones",
      status: "EXPIRED",
      expiresAt: new Date("2025-01-15T00:00:00Z"),
      appUrl: APP_URL,
      brandColor: BRAND,
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).toContain("Please upload or renew your certificate in");
    expect(html).toContain(`<a href="${CTA_URL}">HAVEN Hub</a>`);
  });
});

// ---------------------------------------------------------------------------
// compliance-date-review (sent to compliance managers, not the volunteer)
// ---------------------------------------------------------------------------

describe("compliance-date-review via renderEmail", () => {
  const base: ComplianceDateReviewParams = {
    volunteerName: "Alice Smith",
    reviewLink: "https://hub.example.org/volunteers/master",
  };

  it("subject names a needed completion date", async () => {
    const { subject } = await renderEmail("compliance-date-review", complianceDateReviewContext(base));
    expect(subject).toBe("[HAVEN] HIPAA certificate needs a completion date");
  });

  it("html contains the volunteer name", async () => {
    const { html } = await renderEmail("compliance-date-review", complianceDateReviewContext(base));
    expect(html).toContain("Alice Smith");
  });

  it("html links to the review page", async () => {
    const { html } = await renderEmail("compliance-date-review", complianceDateReviewContext(base));
    expect(html).toContain(`href="https://hub.example.org/volunteers/master"`);
  });

  it("HTML-escapes a malicious volunteerName", async () => {
    const { html } = await renderEmail(
      "compliance-date-review",
      complianceDateReviewContext({ ...base, volunteerName: "<script>evil()</script>" }),
    );
    expect(html).not.toContain("<script>evil");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// The REJECTED reminder branch
//
// Load-bearing rather than cosmetic: the reminder engine treats every
// non-COMPLIANT status as unsatisfied, so a missing branch here is not a copy
// bug -- complianceReminderContext throws, and the first rejected member in the
// nightly run takes their whole per-person iteration with them.
// ---------------------------------------------------------------------------

describe("compliance-reminder REJECTED via renderEmail", () => {
  const APP_URL = "https://hub.example.org";

  function rejectedParams(over: Partial<ComplianceReminderParams> = {}): ComplianceReminderParams {
    return {
      personName: "Jane Doe",
      status: "REJECTED",
      expiresAt: null,
      appUrl: APP_URL,
      brandColor: "#00356b",
      ...over,
    };
  }

  it("renders rather than throwing, which is what the nightly run depends on", async () => {
    await expect(
      renderEmail("compliance-reminder", complianceReminderContext(rejectedParams())),
    ).resolves.toBeDefined();
  });

  it("says the certificate was not accepted, and asks for a new one", async () => {
    const out = await renderEmail(
      "compliance-reminder",
      complianceReminderContext(rejectedParams()),
    );
    expect(out.html).toContain("was not accepted");
    // Actionable, unlike the two waiting states: the member can fix this.
    expect(out.html).toContain("Please upload or renew your certificate");
    expect(out.html).toContain(`${APP_URL}/my-info`);
    expect(out.html).not.toContain("No action is needed");
  });

  it("does not repeat the rejection reason in a recurring nag", async () => {
    // The reason was sent once, at rejection time, by compliance-cert-rejected.
    // Quoting a weeks-old reason beside "upload or renew" reads as a second
    // rejection of a file the member may already have replaced.
    const out = await renderEmail(
      "compliance-reminder",
      complianceReminderContext(rejectedParams()),
    );
    expect(out.html).not.toContain("Workday transcript");
    expect(out.html).not.toContain("issued to someone else");
  });
});

// ---------------------------------------------------------------------------
// compliance-cert-rejected
// ---------------------------------------------------------------------------

describe("compliance-cert-rejected via renderEmail", () => {
  const MY_INFO = "https://hub.example.org/my-info";

  it("names the problem and the one next step", async () => {
    const out = await renderEmail(
      "compliance-cert-rejected",
      complianceCertRejectedContext({
        volunteerName: "Jane Doe",
        explanation:
          "The file you uploaded is not a HIPAA training certificate. This is the Workday transcript.",
        myInfoLink: MY_INFO,
      }),
    );
    expect(out.subject).toBe("[HAVEN] Your HIPAA certificate was not accepted");
    expect(out.html).toContain("Hi Jane Doe,");
    expect(out.html).toContain("is not a HIPAA training certificate");
    expect(out.html).toContain("This is the Workday transcript.");
    expect(out.html).toContain(MY_INFO);
  });

  it("tells the member their clearance is on hold, so the email is not ignorable", async () => {
    const out = await renderEmail(
      "compliance-cert-rejected",
      complianceCertRejectedContext({
        volunteerName: "Jane Doe",
        explanation: "The certificate you uploaded could not be accepted.",
        myInfoLink: MY_INFO,
      }),
    );
    expect(out.html).toContain("on hold");
  });

  it("HTML-escapes the name and the manager's explanation", async () => {
    // The explanation carries a free-text note typed by a manager, so it is the
    // one field on this template with untrusted input in it.
    const out = await renderEmail(
      "compliance-cert-rejected",
      complianceCertRejectedContext({
        volunteerName: '<script>alert("x")</script>',
        explanation: '<img src=x onerror="alert(1)">',
        myInfoLink: MY_INFO,
      }),
    );
    expect(out.html).not.toContain("<script>");
    expect(out.html).not.toContain("<img src=x");
  });
});
