import { describe, expect, it } from "vitest";
import {
  selectCurrentClinicDate,
  formatClinicDate,
  matchChannel,
} from "./channel-link";

// Clinic dates are anchored at 12:00 UTC like Term.clinicDates.
function clinic(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

const dates = [clinic(2026, 6, 6), clinic(2026, 6, 13), clinic(2026, 6, 20)];

describe("selectCurrentClinicDate", () => {
  it("picks the upcoming clinic mid-week (Mon)", () => {
    // Mon 2026-06-08 12:00 UTC -> upcoming is Sat 06-13.
    const now = new Date(Date.UTC(2026, 5, 8, 12, 0, 0));
    expect(selectCurrentClinicDate(dates, now)).toEqual(clinic(2026, 6, 13));
  });

  it("still shows that day's clinic on the clinic Saturday", () => {
    // Sat 2026-06-13 18:00 UTC = 14:00 ET, same NY calendar day.
    const now = new Date(Date.UTC(2026, 5, 13, 18, 0, 0));
    expect(selectCurrentClinicDate(dates, now)).toEqual(clinic(2026, 6, 13));
  });

  it("rolls to the next clinic once it is Sunday in New_York", () => {
    // Sun 2026-06-14 05:00 UTC = Sun 01:00 ET -> 06-13 is past, pick 06-20.
    const now = new Date(Date.UTC(2026, 5, 14, 5, 0, 0));
    expect(selectCurrentClinicDate(dates, now)).toEqual(clinic(2026, 6, 20));
  });

  it("does NOT roll while it is still Saturday night in New_York", () => {
    // Sun 2026-06-14 03:00 UTC = Sat 23:00 ET -> still 06-13.
    const now = new Date(Date.UTC(2026, 5, 14, 3, 0, 0));
    expect(selectCurrentClinicDate(dates, now)).toEqual(clinic(2026, 6, 13));
  });

  it("returns null when all clinic dates are past", () => {
    const now = new Date(Date.UTC(2026, 6, 1, 12, 0, 0));
    expect(selectCurrentClinicDate(dates, now)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(selectCurrentClinicDate([], new Date())).toBeNull();
  });
});

describe("formatClinicDate", () => {
  it("formats as zero-padded MM-DD-YY", () => {
    expect(formatClinicDate(clinic(2026, 6, 13))).toBe("06-13-26");
  });

  it("zero-pads single-digit month and day", () => {
    expect(formatClinicDate(clinic(2026, 1, 3))).toBe("01-03-26");
  });
});

describe("matchChannel", () => {
  const channels = [
    { id: "1", displayName: "General", webUrl: "https://x/general" },
    { id: "2", displayName: "06-13-26 Clinic", webUrl: "https://x/0613" },
    { id: "3", displayName: "06-20-26 Clinic", webUrl: "https://x/0620" },
  ];

  it("matches the channel whose name starts with the date string", () => {
    expect(matchChannel(channels, "06-13-26")?.id).toBe("2");
  });

  it("is case- and whitespace-tolerant", () => {
    const odd = [{ id: "9", displayName: "  06-13-26 clinic ", webUrl: "u" }];
    expect(matchChannel(odd, "06-13-26")?.id).toBe("9");
  });

  it("returns null when no channel matches", () => {
    expect(matchChannel(channels, "07-04-26")).toBeNull();
  });
});
