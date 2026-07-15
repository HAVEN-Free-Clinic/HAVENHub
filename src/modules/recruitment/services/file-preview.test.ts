import { describe, it, expect } from "vitest";
import { isInlinePreviewable } from "./file-preview";

describe("isInlinePreviewable", () => {
  it("allows pdf and common raster images", () => {
    for (const m of ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(isInlinePreviewable(m)).toBe(true);
    }
  });
  it("rejects svg, html, and unknown/empty types (defense against stored XSS)", () => {
    for (const m of ["image/svg+xml", "text/html", "application/octet-stream", "", null, undefined]) {
      expect(isInlinePreviewable(m)).toBe(false);
    }
  });
});
