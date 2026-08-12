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
  // support.ticket_submitted - requester receipt (its own template)
  // ---------------------------------------------------------------------------

  it("support.ticket_submitted confirms receipt to the requester", async () => {
    const out = await renderEmail("support.ticket_submitted", {
      ticketNumber: TICKET_NUMBER,
      subject: SUBJECT,
      link: LINK,
    });
    expect(out.subject).toBe("[HAVEN] We received your IT Support request #42");
    expect(out.html).toContain(
      "<p>Hello,</p>\n\n<p>Thanks for reaching out to IT Support. We have logged your request and someone on the team will follow up. You will get an email as the ticket is updated, and you can reply on it any time.</p>\n\n<p><strong>#42: VPN access issue</strong></p>\n\n<p><a href=\"https://hub.havenfreeclinic.org/support/abc123\">Track your request</a></p>\n\n<p>Thank you,<br>HAVEN IT Support</p>",
    );
    // The receipt never names who submitted it or reads as a manager alert.
    expect(out.html).not.toContain("needs triage");
  });

  // ---------------------------------------------------------------------------
  // support.ticket_manager_alert - manager alert (distinct template)
  // ---------------------------------------------------------------------------

  it("support.ticket_manager_alert alerts managers with requester + category", async () => {
    const out = await renderEmail("support.ticket_manager_alert", {
      ticketNumber: TICKET_NUMBER,
      subject: SUBJECT,
      category: "General IT",
      requesterName: "Jane Doe",
      link: LINK,
    });
    expect(out.subject).toBe("[HAVEN] New IT Support ticket #42 from Jane Doe");
    expect(out.html).toContain(
      "<p>Hello,</p>\n\n<p><strong>Jane Doe</strong> submitted a new IT Support request that needs triage.</p>\n\n<p><strong>#42: VPN access issue</strong><br>\nCategory: General IT</p>\n\n<p><a href=\"https://hub.havenfreeclinic.org/support/abc123\">Review and assign it</a></p>\n\n<p>Thank you,<br>HAVEN IT Support</p>",
    );
    // The manager alert never uses the requester-facing receipt copy.
    expect(out.html).not.toContain("Thanks for reaching out");
  });

  // ---------------------------------------------------------------------------
  // support.request_assigned was REMOVED, not merely left unsent: managers work
  // tickets in Intercom's inbox now, which shows and notifies assignment
  // natively. Asserted rather than silently deleted, so that restoring the
  // notify() call without restoring the descriptor fails loudly at render time
  // instead of at whatever hour the first assignment happens in production.
  // ---------------------------------------------------------------------------

  it("support.request_assigned no longer renders at all", async () => {
    await expect(renderEmail("support.request_assigned", {})).rejects.toThrow(
      /Unknown email template/i
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
