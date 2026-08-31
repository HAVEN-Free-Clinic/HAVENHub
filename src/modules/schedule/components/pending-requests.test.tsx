import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PendingRequests } from "./pending-requests";
import type { RequestRow } from "@/modules/schedule/services/requests";
import type { ShiftRequest } from "@prisma/client";

/**
 * The "Recent decisions" list is the only history a director has of what was
 * done with a request. It used to render nothing but the requester's name and
 * the outcome ("Bonnie Li: approved by Karthik Chetlapalli"), which left three
 * questions unanswerable: which of that person's requests this was, what it
 * asked for, and when it was settled. These cases pin all three.
 */

const ZONE = "America/New_York";

function request(over: Partial<ShiftRequest> = {}): ShiftRequest {
  return {
    id: "r1",
    termId: "t1",
    requesterId: "p1",
    requesterDate: new Date("2026-09-05T12:00:00Z"),
    departmentId: "d1",
    targetId: null,
    targetDate: null,
    status: "APPROVED",
    note: null,
    decidedById: "p9",
    decidedAt: new Date("2026-08-28T15:00:00Z"),
    createdAt: new Date("2026-08-20T12:00:00Z"),
    updatedAt: new Date("2026-08-28T15:00:00Z"),
    ...over,
  } as ShiftRequest;
}

function row(over: Partial<RequestRow> = {}): RequestRow {
  return {
    request: request(),
    requesterName: "Bonnie Li",
    targetName: null,
    decidedByName: "Karthik Chetlapalli",
    ...over,
  };
}

function render(rows: RequestRow[]) {
  return renderToStaticMarkup(
    <PendingRequests
      rows={rows}
      approveAction={async () => {}}
      denyAction={async () => {}}
      todayKey="2026-08-31"
      timeZone={ZONE}
    />,
  );
}

describe("PendingRequests: recent decisions", () => {
  it("names the outcome, who decided it, and the day they decided", () => {
    const html = render([row()]);
    expect(html).toContain("Bonnie Li");
    expect(html).toContain("approved");
    expect(html).toContain("Karthik Chetlapalli");
    expect(html).toContain("Aug 28");
  });

  it("says what the request actually asked for", () => {
    const html = render([row()]);
    expect(html).toContain("Drop: September 5th");
  });

  it("names the swap partner and both dates on a swap", () => {
    const html = render([
      row({
        request: request({
          targetId: "p2",
          targetDate: new Date("2026-09-19T12:00:00Z"),
        }),
        targetName: "Tyger Lin",
      }),
    ]);
    expect(html).toContain("Swap: September 5th with Tyger Lin (September 19th)");
  });

  // cancelRequest sets CANCELLED and never stamps decidedAt, so a cancelled row
  // reaching for decidedAt alone would render the fallback dash (or nothing) on
  // exactly the rows the screenshot showed most of.
  it("dates a cancelled request from updatedAt, since cancelling stamps no decidedAt", () => {
    const html = render([
      row({
        request: request({
          status: "CANCELLED",
          decidedById: null,
          decidedAt: null,
          updatedAt: new Date("2026-08-26T15:00:00Z"),
        }),
        decidedByName: null,
      }),
    ]);
    expect(html).toContain("cancelled");
    expect(html).toContain("Aug 26");
    expect(html).not.toContain("by ");
  });

  // Two identical-looking rows are exactly the case in the report: the same
  // person, the same outcome, twice. The clinic date is what tells them apart.
  it("distinguishes two decisions from the same person by their clinic dates", () => {
    const html = render([
      row({ request: request({ id: "r1", requesterDate: new Date("2026-09-05T12:00:00Z") }) }),
      row({ request: request({ id: "r2", requesterDate: new Date("2026-09-19T12:00:00Z") }) }),
    ]);
    expect(html).toContain("Drop: September 5th");
    expect(html).toContain("Drop: September 19th");
  });

  // A decidedAt is a real instant, unlike the noon-UTC clinic dates beside it.
  // Formatting it in UTC would date an evening decision to the following day.
  it("renders the decision day in the display zone, not UTC", () => {
    const html = render([
      // 00:30 UTC on Aug 29 is 8:30pm ET on Aug 28.
      row({ request: request({ decidedAt: new Date("2026-08-29T00:30:00Z") }) }),
    ]);
    expect(html).toContain("Aug 28");
    expect(html).not.toContain("Aug 29");
  });

  it("leaves the pending rows alone", () => {
    const html = render([
      row({ request: request({ status: "PENDING", decidedById: null, decidedAt: null }) }),
    ]);
    expect(html).toContain("Approve");
    expect(html).not.toContain("Recent decisions");
  });
});
