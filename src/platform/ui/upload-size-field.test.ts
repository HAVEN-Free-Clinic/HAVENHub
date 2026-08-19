import { describe, expect, it } from "vitest";
import { oversizeMessage } from "./upload-size-field";

const mb = (n: number) => n * 1024 * 1024;

describe("oversizeMessage", () => {
  it("returns '' when every file fits, which is what setCustomValidity wants for valid", () => {
    expect(oversizeMessage([], 4)).toBe("");
    expect(oversizeMessage([{ name: "a.pdf", size: mb(1) }], 4)).toBe("");
  });

  it("accepts a file exactly at the cap", () => {
    // The cap is inclusive on the server too; rejecting here but accepting there
    // (or the reverse) is the failure mode this pins.
    expect(oversizeMessage([{ name: "a.pdf", size: mb(4) }], 4)).toBe("");
  });

  it("rejects one byte over, naming the file and the cap", () => {
    expect(oversizeMessage([{ name: "scan.pdf", size: mb(4) + 1 }], 4)).toBe(
      '"scan.pdf" is too large (max 4 MB).',
    );
  });

  it("names the first oversized file in a multi-file selection", () => {
    const message = oversizeMessage(
      [
        { name: "ok.jpg", size: mb(1) },
        { name: "huge.jpg", size: mb(9) },
        { name: "also-huge.jpg", size: mb(12) },
      ],
      4,
    );
    expect(message).toContain("huge.jpg");
    expect(message).not.toContain("also-huge.jpg");
    expect(message).not.toContain("ok.jpg");
  });

  it("measures MB the way the setting means them (1024-based)", () => {
    // 4,500,000 bytes is over 4 MiB but under 4.5 "MB" decimal. Reading the cap
    // as decimal here would let it through the browser and then die at the edge,
    // which is the exact silence this guard exists to prevent.
    expect(oversizeMessage([{ name: "x.png", size: 4_500_000 }], 4)).not.toBe("");
  });
});
