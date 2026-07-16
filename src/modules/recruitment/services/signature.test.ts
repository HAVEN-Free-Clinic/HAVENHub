import { describe, expect, it } from "vitest";
import { decodeSignaturePng, isSignatureDataUrl, SignatureError, SIGNATURE_MAX_BYTES } from "./signature";

// A 1x1 transparent PNG.
const PNG_1x1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC";

describe("decodeSignaturePng", () => {
  it("decodes a valid image/png data URL to bytes", () => {
    const buf = decodeSignaturePng(PNG_1x1);
    expect(buf.length).toBeGreaterThan(0);
    // PNG magic bytes.
    expect([buf[0], buf[1], buf[2], buf[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("rejects a non-png data URL", () => {
    expect(() => decodeSignaturePng("data:image/jpeg;base64,/9j/4AAQ")).toThrow(SignatureError);
  });

  it("rejects an empty string", () => {
    expect(() => decodeSignaturePng("")).toThrow(SignatureError);
  });

  it("rejects a data URL whose bytes are not a PNG", () => {
    // Correct prefix, but the decoded bytes are 'hello' (no PNG magic).
    expect(() => decodeSignaturePng("data:image/png;base64,aGVsbG8=")).toThrow(SignatureError);
  });

  it("rejects an oversized payload", () => {
    const big = "A".repeat(Math.ceil((SIGNATURE_MAX_BYTES + 1024) / 3) * 4);
    expect(() => decodeSignaturePng(`data:image/png;base64,${big}`)).toThrow(SignatureError);
  });

  it("isSignatureDataUrl narrows correctly", () => {
    expect(isSignatureDataUrl(PNG_1x1)).toBe(true);
    expect(isSignatureDataUrl("nope")).toBe(false);
    expect(isSignatureDataUrl(42)).toBe(false);
  });
});
