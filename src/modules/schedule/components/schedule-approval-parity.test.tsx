import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PendingRequests } from "./pending-requests";
import { AttendingPendingRequests } from "./attending-pending-requests";
import type { RequestRow } from "@/modules/schedule/services/requests";
import type { AttendingRequestRow } from "@/modules/schedule/services/attending-portal";
import type { ShiftRequest } from "@prisma/client";

/**
 * These two panels stack on ONE page, /schedule/requests, and settle the same
 * kind of request. They drifted anyway: the attending panel's Deny was a solid
 * red button that took effect in a single click, sitting directly beside an
 * Approve that asked to be confirmed, while the volunteer panel below it had
 * already settled on outline-plus-confirm for both. So the routine, reversible
 * action was the quiet one and the irreversible one was the loud one-click one.
 *
 * Asserted against EACH OTHER rather than against a fixed string, because the
 * defect was never a wrong value -- it was two panels disagreeing.
 */

const ZONE = "America/New_York";
const TODAY = "2026-08-31";
const noop = async () => {};

function volunteerHtml(): string {
  const request = {
    id: "r1", termId: "t1", requesterId: "p1",
    requesterDate: new Date("2026-09-05T12:00:00Z"),
    departmentId: "d1", targetId: null, targetDate: null,
    status: "PENDING", note: null, decidedById: null, decidedAt: null,
    createdAt: new Date("2026-08-20T12:00:00Z"),
    updatedAt: new Date("2026-08-20T12:00:00Z"),
  } as ShiftRequest;
  const rows: RequestRow[] = [
    { request, requesterName: "Bonnie Li", targetName: null, decidedByName: null },
  ];
  return renderToStaticMarkup(
    <PendingRequests rows={rows} approveAction={noop} denyAction={noop} todayKey={TODAY} timeZone={ZONE} />,
  );
}

function attendingHtml(): string {
  const rows: AttendingRequestRow[] = [
    {
      id: "a1", status: "PENDING", isSwap: false, note: null,
      createdAt: new Date("2026-08-20T12:00:00Z"),
      decidedAt: null,
      updatedAt: new Date("2026-08-20T12:00:00Z"),
      requester: { id: "at1", name: "Dr Peggy Bia" },
      requesterDate: new Date("2026-09-05T12:00:00Z"),
      requesterSlotLabel: "Morning",
      target: null,
    },
  ];
  return renderToStaticMarkup(
    <AttendingPendingRequests rows={rows} approveAction={noop} denyAction={noop} todayKey={TODAY} timeZone={ZONE} />,
  );
}

/** The <form> that submits a denial, in either panel. */
const denyForm = (html: string) =>
  html.split("<form").find((chunk) => chunk.includes("Deny")) ?? "";

describe("the two approval panels on /schedule/requests", () => {
  it("both make Deny confirm, because denying ends the request", () => {
    // ConfirmButton's tell: it arms rather than submitting, so the idle control
    // is a plain button that is not type=submit.
    for (const [name, html] of [["volunteer", volunteerHtml()], ["attending", attendingHtml()]] as const) {
      expect(denyForm(html), `${name} panel`).not.toContain('type="submit"');
    }
  });

  it("neither draws Deny louder than the Approve beside it", () => {
    // bg-critical is Button's solid `danger` fill. ConfirmButton uses it only
    // once ARMED, which server-rendered markup never is.
    for (const [name, html] of [["volunteer", volunteerHtml()], ["attending", attendingHtml()]] as const) {
      expect(html, `${name} panel`).not.toContain("bg-critical");
    }
  });

  it("both offer a denial reason, so the same refusal is explained either way", () => {
    for (const [name, html] of [["volunteer", volunteerHtml()], ["attending", attendingHtml()]] as const) {
      expect(html, `${name} panel`).toContain('name="denyNote"');
      expect(html, `${name} panel`).toContain('aria-label="Denial reason"');
    }
  });
});
