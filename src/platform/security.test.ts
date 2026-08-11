import { describe, it, expect } from "vitest";
import { constantTimeBearerMatch } from "./security";

const SECRET = "s3cr3t-high-entropy-value";

describe("constantTimeBearerMatch", () => {
  it("matches the exact bearer header", () => {
    expect(constantTimeBearerMatch(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("rejects a wrong secret of the same length", () => {
    const wrong = "x".repeat(SECRET.length);
    expect(constantTimeBearerMatch(`Bearer ${wrong}`, SECRET)).toBe(false);
  });

  it("rejects a header of a different length without throwing", () => {
    // timingSafeEqual requires equal-length buffers; the length guard must
    // short-circuit so a mismatched length returns false, never throws.
    expect(() => constantTimeBearerMatch("Bearer short", SECRET)).not.toThrow();
    expect(constantTimeBearerMatch("Bearer short", SECRET)).toBe(false);
    expect(constantTimeBearerMatch(`Bearer ${SECRET}-extra`, SECRET)).toBe(false);
  });

  it("rejects a null header", () => {
    expect(constantTimeBearerMatch(null, SECRET)).toBe(false);
  });

  it("rejects a header missing the Bearer scheme", () => {
    expect(constantTimeBearerMatch(SECRET, SECRET)).toBe(false);
  });
});
