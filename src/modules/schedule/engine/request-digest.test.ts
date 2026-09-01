import { describe, expect, it } from "vitest";
import {
  DIGEST_STALE_DAYS,
  belongsInDigest,
  buildRequestDigest,
  type DigestEntry,
} from "./request-digest";
import { CADENCE, URGENT_WINDOW_DAYS } from "./request-reminder-cadence";

const DAY_MS = 24 * 60 * 60 * 1000;

function entry(over: Partial<DigestEntry> = {}): DigestEntry {
  return {
    departmentId: "d1",
    departmentName: "Internal Medicine",
    requesterName: "Alex Johnson",
    requesterDate: "July 15, 2026",
    partner: null,
    urgency: "NORMAL",
    ageMs: 3 * DAY_MS,
    ...over,
  };
}

describe("belongsInDigest", () => {
  it("escalates a coming-week request at any age, including one filed minutes ago", () => {
    expect(belongsInDigest({ urgency: "URGENT", ageMs: 0 })).toBe(true);
    expect(belongsInDigest({ urgency: "URGENT", ageMs: 60 * 1000 })).toBe(true);
  });

  it("gives everything else the full stale window before escalating", () => {
    const stale = DIGEST_STALE_DAYS * DAY_MS;
    expect(belongsInDigest({ urgency: "NORMAL", ageMs: stale - 1 })).toBe(false);
    expect(belongsInDigest({ urgency: "NORMAL", ageMs: stale })).toBe(true);
  });

  // The whole point of the second lane is that it fires only after the
  // department's own reminder went unheeded. A threshold at or below the NORMAL
  // cadence's first reminder would make the digest a same-day duplicate of it.
  it("waits longer than the department's own first reminder", () => {
    expect(DIGEST_STALE_DAYS * DAY_MS).toBeGreaterThan(CADENCE.NORMAL.minAgeMs);
  });
});

describe("buildRequestDigest", () => {
  it("sends nothing to say when nothing is pending", () => {
    expect(buildRequestDigest([])).toEqual({ pendingSummary: "", requestList: "" });
  });

  it("counts the requests in the subject summary, singular and plural", () => {
    expect(buildRequestDigest([entry()]).pendingSummary).toBe("1 shift request");
    expect(buildRequestDigest([entry(), entry()]).pendingSummary).toBe("2 shift requests");
  });

  it("names a drop and a swap differently, and names the swap partner", () => {
    const { requestList } = buildRequestDigest([
      entry(),
      entry({ partner: { name: "Jordan Lee", date: "July 22, 2026" } }),
    ]);
    expect(requestList).toContain("Drop: Alex Johnson (July 15, 2026), pending 3 days");
    expect(requestList).toContain(
      "Swap: Alex Johnson (July 15, 2026) with Jordan Lee (July 22, 2026), pending 3 days",
    );
  });

  it("groups by department, one block each, in first-appearance order", () => {
    const { requestList } = buildRequestDigest([
      entry({ departmentId: "d2", departmentName: "Behavioral Health" }),
      entry({ departmentId: "d1", departmentName: "Internal Medicine" }),
      entry({ departmentId: "d2", departmentName: "Behavioral Health", requesterName: "Casey Ng" }),
    ]);
    // Two blocks, not three: the second Behavioral Health request joins the first.
    expect(requestList.match(/<p><strong>/g)).toHaveLength(2);
    expect(requestList.indexOf("Behavioral Health")).toBeLessThan(
      requestList.indexOf("Internal Medicine"),
    );
    // ...and it is inside that block rather than trailing after the other one.
    const behavioral = requestList.split("</p>")[0];
    expect(behavioral).toContain("Casey Ng");
  });

  // Two departments sharing a display name must not be merged into one block:
  // the reader would read one department's backlog as the other's.
  it("keys grouping on the department id, not the display name", () => {
    const { requestList } = buildRequestDigest([
      entry({ departmentId: "d1", departmentName: "Pediatrics" }),
      entry({ departmentId: "d2", departmentName: "Pediatrics" }),
    ]);
    expect(requestList.match(/<p><strong>/g)).toHaveLength(2);
  });

  it("flags a request whose clinic date is inside the urgent window", () => {
    const urgent = buildRequestDigest([entry({ urgency: "URGENT" })]).requestList;
    expect(urgent).toContain(`<strong>(clinic within ${URGENT_WINDOW_DAYS} days)</strong>`);
    expect(buildRequestDigest([entry()]).requestList).not.toContain("clinic within");
  });

  it("reads the age in whole days, and says so when it is under one", () => {
    expect(buildRequestDigest([entry({ ageMs: 13 * 60 * 60 * 1000 })]).requestList).toContain(
      "pending less than a day",
    );
    expect(buildRequestDigest([entry({ ageMs: DAY_MS })]).requestList).toContain("pending 1 day");
    expect(buildRequestDigest([entry({ ageMs: 2.9 * DAY_MS })]).requestList).toContain(
      "pending 2 days",
    );
  });

  // The list is injected with {{{ }}}, so the renderer will NOT escape it. Every
  // name and date has to arrive already escaped or a member called "Jack <O'Neil"
  // breaks the markup of an email going to the whole executive team.
  it("escapes every value it interpolates, since the template renders it raw", () => {
    const { requestList } = buildRequestDigest([
      entry({
        departmentName: "R&D <b>",
        requesterName: "Jack <script>",
        partner: { name: "O'Neil & Co", date: "July 22, 2026" },
      }),
    ]);
    expect(requestList).not.toContain("<script>");
    expect(requestList).not.toContain("<b>");
    expect(requestList).toContain("&lt;script&gt;");
    expect(requestList).toContain("R&amp;D");
  });
});
