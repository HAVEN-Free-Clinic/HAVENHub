/**
 * Golden-render tests for IT Support ticket email templates via renderEmail.
 *
 * The five support.* descriptors (src/platform/email/templates/support.ts) have no
 * dedicated integration/unit test elsewhere. Rendering each one here, mirroring the
 * convention in epic.golden.test.ts, both locks in the expected copy and doubles as a
 * descriptor-integrity guard: renderEmail() throws on an unknown-variable reference
 * or an unbalanced {{#if}}, and a wrong {{#if}} branch or stale variable name would
 * change the asserted body text.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { renderEmail } from "./renderEmail";

beforeEach(resetDb);

const TICKET_NUMBER = "42";
const SUBJECT = "VPN access issue";
const LINK = "https://hub.havenfreeclinic.org/support/abc123";

describe("support templates via renderEmail (body inside branded layout)", () => {
  // ---------------------------------------------------------------------------
  // support.ticket_submitted - requester confirmation variant
  // ---------------------------------------------------------------------------

  it("support.ticket_submitted requester variant confirms receipt", async () => {
    const out = await renderEmail("support.ticket_submitted", {
      ticketNumber: TICKET_NUMBER,
      subject: SUBJECT,
      link: LINK,
      isManager: false,
      requesterName: "Jane Doe",
    });
    expect(out.subject).toBe("[HAVEN] Your IT Support ticket #42 was received");
    expect(out.html).toContain(
      "<p>Hello,</p>\n\n<p>We received your IT Support ticket and will follow up soon.</p>\n\n<p><strong>#42: VPN access issue</strong></p>\n\n<p><a href=\"https://hub.havenfreeclinic.org/support/abc123\">Track your ticket</a></p>\n\n<p>Thank you,<br>HAVEN IT Support</p>",
    );
    // The requester variant never names who submitted it or offers a manager-style link.
    expect(out.html).not.toContain("submitted a new IT Support ticket");
  });

  // ---------------------------------------------------------------------------
  // support.ticket_submitted - manager alert variant
  // ---------------------------------------------------------------------------

  it("support.ticket_submitted manager variant alerts with requester name", async () => {
    const out = await renderEmail("support.ticket_submitted", {
      ticketNumber: TICKET_NUMBER,
      subject: SUBJECT,
      link: LINK,
      isManager: true,
      requesterName: "Jane Doe",
    });
    expect(out.subject).toBe("[HAVEN] New IT Support ticket #42");
    expect(out.html).toContain(
      "<p>Hello,</p>\n\n<p>Jane Doe submitted a new IT Support ticket.</p>\n\n<p><strong>#42: VPN access issue</strong></p>\n\n<p><a href=\"https://hub.havenfreeclinic.org/support/abc123\">View the ticket</a></p>\n\n<p>Thank you,<br>HAVEN IT Support</p>",
    );
    // The manager variant never uses the requester-facing "we received" copy.
    expect(out.html).not.toContain("We received your IT Support ticket");
  });

  // ---------------------------------------------------------------------------
  // support.request_assigned
  // ---------------------------------------------------------------------------

  it("support.request_assigned names the assignee", async () => {
    const out = await renderEmail("support.request_assigned", {
      ticketNumber: TICKET_NUMBER,
      subject: SUBJECT,
      assigneeName: "Pat Manager",
      link: LINK,
    });
    expect(out.subject).toBe("[HAVEN] IT Support ticket #42 assigned");
    expect(out.html).toContain(
      "<p>Hello,</p>\n\n<p>IT Support ticket <strong>#42: VPN access issue</strong> has been assigned to Pat Manager.</p>\n\n<p><a href=\"https://hub.havenfreeclinic.org/support/abc123\">View the ticket</a></p>\n\n<p>Thank you,<br>HAVEN IT Support</p>",
    );
  });

  // ---------------------------------------------------------------------------
  // support.status_changed
  // ---------------------------------------------------------------------------

  it("support.status_changed announces the new status", async () => {
    const out = await renderEmail("support.status_changed", {
      ticketNumber: TICKET_NUMBER,
      subject: SUBJECT,
      statusLabel: "In Progress",
      link: LINK,
    });
    expect(out.subject).toBe("[HAVEN] IT Support ticket #42 update");
    expect(out.html).toContain(
      "<p>Hello,</p>\n\n<p>IT Support ticket <strong>#42: VPN access issue</strong> is now <strong>In Progress</strong>.</p>\n\n<p><a href=\"https://hub.havenfreeclinic.org/support/abc123\">View the ticket</a></p>\n\n<p>Thank you,<br>HAVEN IT Support</p>",
    );
  });

  // ---------------------------------------------------------------------------
  // support.comment_added
  // ---------------------------------------------------------------------------

  it("support.comment_added names the comment author", async () => {
    const out = await renderEmail("support.comment_added", {
      ticketNumber: TICKET_NUMBER,
      subject: SUBJECT,
      authorName: "Pat Manager",
      link: LINK,
    });
    expect(out.subject).toBe("[HAVEN] New comment on IT Support ticket #42");
    expect(out.html).toContain(
      "<p>Hello,</p>\n\n<p>Pat Manager added a comment on IT Support ticket <strong>#42: VPN access issue</strong>.</p>\n\n<p><a href=\"https://hub.havenfreeclinic.org/support/abc123\">View the comment</a></p>\n\n<p>Thank you,<br>HAVEN IT Support</p>",
    );
  });

  // ---------------------------------------------------------------------------
  // support.request_resolved - with a resolution note
  // ---------------------------------------------------------------------------

  it("support.request_resolved with a resolution note includes it", async () => {
    const out = await renderEmail("support.request_resolved", {
      ticketNumber: TICKET_NUMBER,
      subject: SUBJECT,
      resolution: "Reset the WiFi adapter driver.",
      hasResolution: true,
      link: LINK,
    });
    expect(out.subject).toBe("[HAVEN] IT Support ticket #42 resolved");
    expect(out.html).toContain(
      "<p>Hello,</p>\n\n<p>Your IT Support ticket <strong>#42: VPN access issue</strong> has been resolved.</p>\n\n<p>Reset the WiFi adapter driver.</p>\n\n<p>If this didn't fix things, reply on the ticket and we'll follow up.</p>\n\n<p><a href=\"https://hub.havenfreeclinic.org/support/abc123\">View the ticket</a></p>\n\n<p>Thank you,<br>HAVEN IT Support</p>",
    );
  });

  // ---------------------------------------------------------------------------
  // support.request_resolved - no resolution note
  // ---------------------------------------------------------------------------

  it("support.request_resolved without a resolution note omits it", async () => {
    const out = await renderEmail("support.request_resolved", {
      ticketNumber: TICKET_NUMBER,
      subject: SUBJECT,
      resolution: "",
      hasResolution: false,
      link: LINK,
    });
    expect(out.subject).toBe("[HAVEN] IT Support ticket #42 resolved");
    expect(out.html).toContain(
      "<p>Hello,</p>\n\n<p>Your IT Support ticket <strong>#42: VPN access issue</strong> has been resolved.</p>\n\n\n\n<p>If this didn't fix things, reply on the ticket and we'll follow up.</p>\n\n<p><a href=\"https://hub.havenfreeclinic.org/support/abc123\">View the ticket</a></p>\n\n<p>Thank you,<br>HAVEN IT Support</p>",
    );
    expect(out.html).not.toContain("Reset the WiFi adapter driver.");
  });
});
