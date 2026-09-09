import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SHIFT_REQUEST_COPY } from "./shift-parts";

/**
 * Both halves of /schedule say the same thing about a request.
 *
 * shift-parts.tsx's own header already named "Cancel request" against "Withdraw
 * request" as a drift it existed to end, and then left it in place: the
 * attending half said Withdraw for the identical action the volunteer half
 * called Cancel, under a heading "Give up this date" against "Request a drop".
 * Somebody who is both -- a PA who also volunteers, a faculty member who directs
 * a department -- scrolls past both halves on one page.
 *
 * A source guard, not a render assertion, because the failure mode is somebody
 * typing a NEW literal into one half. Rendering proves the two agree today;
 * this proves the words have one home.
 */
const SITES = [
  "src/app/(app)/schedule/page.tsx",
  "src/modules/schedule/components/attending-portal-section.tsx",
  "src/modules/schedule/components/pending-requests.tsx",
  "src/modules/schedule/components/attending-pending-requests.tsx",
];

/** What each half used to say for the other half's action. */
const RETIRED = [
  "Withdraw request",
  "Withdraw this request?",
  "Give up this date",
  "Request to drop this date?",
  "No pending attending requests.",
];

describe("the /schedule request vocabulary", () => {
  it("has no half saying the other half's words", () => {
    const offenders: string[] = [];
    for (const file of SITES) {
      const src = readFileSync(file, "utf8");
      for (const phrase of RETIRED) {
        if (src.includes(phrase)) offenders.push(`${file}: ${phrase}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the shared words out of the call sites entirely", () => {
    // A literal that happens to MATCH the constant is still a second home for
    // it, and is how these drifted the first time.
    const shared = [
      SHIFT_REQUEST_COPY.cancelLabel,
      SHIFT_REQUEST_COPY.cancelConfirm,
      SHIFT_REQUEST_COPY.dropHeading,
      SHIFT_REQUEST_COPY.dropLabel,
      SHIFT_REQUEST_COPY.dropConfirm,
      SHIFT_REQUEST_COPY.noPending,
    ];
    const offenders: string[] = [];
    for (const file of SITES) {
      const src = readFileSync(file, "utf8");
      for (const phrase of shared) {
        if (src.includes(`"${phrase}"`)) offenders.push(`${file}: ${phrase}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("says nothing about WHOSE requests are missing, which the header above already says", () => {
    expect(SHIFT_REQUEST_COPY.noPending).toBe("No pending requests.");
    expect(SHIFT_REQUEST_COPY.noPending).not.toContain("attending");
  });
});
