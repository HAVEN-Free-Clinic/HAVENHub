import { describe, it, expect } from "vitest";
import { constantTimeBearerMatch, constantTimeEqual } from "./security";

const SECRET = "s3cr3t-high-entropy-value";

describe("constantTimeEqual", () => {
  it("matches identical strings", () => {
    expect(constantTimeEqual("sha1=abc123", "sha1=abc123")).toBe(true);
  });

  it("rejects a different string of the same length without throwing", () => {
    expect(() => constantTimeEqual("sha1=abc123", "sha1=abc124")).not.toThrow();
    expect(constantTimeEqual("sha1=abc123", "sha1=abc124")).toBe(false);
  });

  it("rejects strings of different length without throwing", () => {
    expect(() => constantTimeEqual("short", "much-longer-value")).not.toThrow();
    expect(constantTimeEqual("short", "much-longer-value")).toBe(false);
  });

  it("rejects an empty string against a non-empty one", () => {
    expect(constantTimeEqual("", "x")).toBe(false);
  });
});

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
