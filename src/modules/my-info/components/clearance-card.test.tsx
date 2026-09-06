/**
 * The load-bearing behaviour here is that a checklist row goes somewhere.
 *
 * Members read the banner ("finish the unchecked items below") and then click
 * the rows themselves -- the label, the status badge, anywhere across the row.
 * Before these rows carried a href those clicks hit nothing: 51 members clicked
 * "EHS training" and 36 clicked its status badge over one month, with no
 * navigation and no DOM change (PostHog inbox 01a036e2). So the tests assert the
 * whole row is inside the anchor, not merely that a link exists somewhere.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ClearanceCard,
  certRequirement,
  taskRequirement,
  type Requirement,
} from "./clearance-card";

const render = (requirements: Requirement[], cleared = false) =>
  renderToStaticMarkup(
    <ClearanceCard requirements={requirements} cleared={cleared} termName="Summer 2026" />,
  );

/** The markup of the one <li>, so "inside the link" can be asserted structurally. */
function rowHtml(html: string): string {
  const start = html.indexOf("<li");
  return html.slice(start, html.indexOf("</li>", start));
}

describe("ClearanceCard rows", () => {
  it("wraps the whole row -- label and status badge -- in the link", () => {
    const row = rowHtml(
      render([taskRequirement("EHS training", "IN_PROGRESS", "member", "#ehs-training")]),
    );
    const anchor = row.slice(row.indexOf("<a"), row.indexOf("</a>"));
    expect(anchor).toContain('href="#ehs-training"');
    // Both are what members actually click, so both must be inside the anchor.
    expect(anchor).toContain("EHS training");
    expect(anchor).toContain("In progress");
  });

  it("renders no link when there is nowhere to send the reader", () => {
    // A row with no destination is inert on purpose (a director reading someone
    // else's record); it must not render a bare anchor with no href.
    const row = rowHtml(render([taskRequirement("Volunteer training", "INCOMPLETE", "staff")]));
    expect(row).not.toContain("<a");
    expect(row).toContain("Volunteer training");
    expect(row).toContain("Incomplete");
  });

  it("links a met row too, so its click is not swallowed either", () => {
    // "Valid" still answers a real question -- members click it to see the cert.
    const row = rowHtml(render([certRequirement("COMPLIANT", "member", "#hipaa-certificate")]));
    expect(row).toContain('href="#hipaa-certificate"');
    expect(row).toContain("Valid");
  });

  it("carries the href through every compliance status", () => {
    const statuses = [
      "COMPLIANT",
      "EXPIRING_SOON",
      "EXPIRED",
      "UNKNOWN_DATE",
      "PENDING_VERIFICATION",
      "NO_CERTIFICATE",
    ] as const;
    for (const status of statuses) {
      expect(certRequirement(status, "member", "#hipaa-certificate").href).toBe("#hipaa-certificate");
    }
  });

  it("carries the href through every task state", () => {
    const states = ["COMPLETE", "IN_PROGRESS", "INCOMPLETE", "NOT_REQUIRED"] as const;
    for (const state of states) {
      expect(taskRequirement("EHS training", state, "member", "#ehs-training").href).toBe("#ehs-training");
    }
  });

  it("leaves href undefined when the caller omits it", () => {
    expect(certRequirement("EXPIRED", "member").href).toBeUndefined();
    expect(taskRequirement("Learning modules", "INCOMPLETE", "member").href).toBeUndefined();
  });

  it("speaks to the reader, so one row reads differently to a member and a director", () => {
    // Same underlying state, same component: only the audience differs.
    const member = taskRequirement("Volunteer training", "INCOMPLETE", "member", "#training");
    const staff = taskRequirement("Volunteer training", "INCOMPLETE", "staff", "#training");
    expect(member.statusLabel).toBe("Action needed");
    expect(staff.statusLabel).toBe("Incomplete");
  });

  it("softens an outstanding row a member cannot act on, since there is no CTA to find", () => {
    expect(taskRequirement("EHS training", "INCOMPLETE", "member").statusLabel).toBe("Pending");
    expect(taskRequirement("EHS training", "INCOMPLETE", "member", "#ehs").statusLabel).toBe(
      "Action needed",
    );
  });

  it("keeps met independent of audience, because gating is not wording", () => {
    for (const audience of ["member", "staff"] as const) {
      expect(certRequirement("COMPLIANT", audience).met).toBe(true);
      expect(certRequirement("EXPIRING_SOON", audience).met).toBe(true);
      expect(certRequirement("PENDING_VERIFICATION", audience).met).toBe(false);
      expect(taskRequirement("x", "NOT_REQUIRED", audience).met).toBe(true);
      expect(taskRequirement("x", "IN_PROGRESS", audience).met).toBe(false);
    }
  });
});
