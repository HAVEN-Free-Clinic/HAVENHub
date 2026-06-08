import { describe, expect, it } from "vitest";
import { displayDate } from "./display";

describe("displayDate", () => {
  it("formats July 4th correctly", () => {
    expect(displayDate("2026-07-04")).toBe("July 4th");
  });

  it("uses 'th' suffix for 11 (teens exception)", () => {
    expect(displayDate("2026-07-11")).toBe("July 11th");
  });

  it("uses 'th' suffix for 12 (teens exception)", () => {
    expect(displayDate("2026-07-12")).toBe("July 12th");
  });

  it("uses 'th' suffix for 13 (teens exception)", () => {
    expect(displayDate("2026-07-13")).toBe("July 13th");
  });

  it("uses 'st' suffix for August 1st", () => {
    expect(displayDate("2026-08-01")).toBe("August 1st");
  });

  it("uses 'nd' suffix for August 22nd", () => {
    expect(displayDate("2026-08-22")).toBe("August 22nd");
  });

  it("uses 'rd' suffix for August 23rd", () => {
    expect(displayDate("2026-08-23")).toBe("August 23rd");
  });

  it("uses 'th' suffix for September 12th", () => {
    expect(displayDate("2026-09-12")).toBe("September 12th");
  });

  it("uses 'st' suffix for 21st", () => {
    expect(displayDate("2026-07-21")).toBe("July 21st");
  });

  it("uses 'nd' suffix for 2nd", () => {
    expect(displayDate("2026-07-02")).toBe("July 2nd");
  });

  it("uses 'rd' suffix for 3rd", () => {
    expect(displayDate("2026-07-03")).toBe("July 3rd");
  });

  it("uses 'th' suffix for 4th through 10th", () => {
    expect(displayDate("2026-07-04")).toBe("July 4th");
    expect(displayDate("2026-07-10")).toBe("July 10th");
  });
});
