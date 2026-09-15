import { describe, it, expect } from "vitest";
import { applicationAvailabilityLabels } from "./application-availability";

/** Noon UTC, the way Term.clinicDates stores a clinic day. */
const clinic = (iso: string) => new Date(`${iso}T12:00:00.000Z`);
const TERM = [clinic("2026-10-03"), clinic("2026-10-10"), clinic("2026-10-17")];

describe("applicationAvailabilityLabels", () => {
  it("labels the chosen clinic dates in calendar order, the way the picker did", () => {
    const labels = applicationAvailabilityLabels({ availability: ["2026-10-17", "2026-10-03"] }, TERM);
    expect(labels).toEqual(["Sat, Oct 3", "Sat, Oct 17"]);
  });

  it("drops a chosen date that is no longer on the clinic calendar", () => {
    expect(applicationAvailabilityLabels({ availability: ["2026-10-03", "2026-10-04"] }, TERM)).toEqual(["Sat, Oct 3"]);
  });

  it("is empty when the application has no availability answer", () => {
    expect(applicationAvailabilityLabels({}, TERM)).toEqual([]);
    expect(applicationAvailabilityLabels(null, TERM)).toEqual([]);
  });
});
