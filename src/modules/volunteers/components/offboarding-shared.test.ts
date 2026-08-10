import { describe, expect, it } from "vitest";
import { filenameFrom } from "./offboarding-shared";

describe("filenameFrom", () => {
  it("pulls the filename out of a quoted Content-Disposition header", () => {
    expect(filenameFrom('attachment; filename="haven-offboarding-SP99-2026-08-07.csv"')).toBe(
      "haven-offboarding-SP99-2026-08-07.csv",
    );
  });

  it("falls back to the default when the header is null", () => {
    expect(filenameFrom(null)).toBe("offboarding.csv");
  });

  it("falls back to the default when the header has no filename parameter", () => {
    expect(filenameFrom("attachment")).toBe("offboarding.csv");
  });
});
