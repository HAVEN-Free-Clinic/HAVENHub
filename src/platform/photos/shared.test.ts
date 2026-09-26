import { describe, expect, it } from "vitest";
import { photoUrl, isHeic, looksLikeHeif } from "./shared";

describe("photoUrl", () => {
  it("pins the exact route and query string", () => {
    expect(photoUrl({ id: "p1", photoVersion: 3 })).toBe("/api/people/p1/photo?v=3");
  });

  it("pins version 0, the schema default every backfilled row starts at", () => {
    expect(photoUrl({ id: "p1", photoVersion: 0 })).toBe("/api/people/p1/photo?v=0");
  });

  it("carries the id through unchanged", () => {
    expect(photoUrl({ id: "abc-123", photoVersion: 7 })).toBe("/api/people/abc-123/photo?v=7");
  });
});

describe("isHeic", () => {
  it("recognizes an iPhone photo by type or by extension", () => {
    expect(isHeic({ type: "image/heic", name: "IMG_1.HEIC" })).toBe(true);
    expect(isHeic({ type: "image/heif", name: "x" })).toBe(true);
    expect(isHeic({ type: "", name: "IMG_2.heic" })).toBe(true);
  });

  it("leaves other images alone", () => {
    expect(isHeic({ type: "image/jpeg", name: "me.jpg" })).toBe(false);
    expect(isHeic({ type: "image/png", name: "heic-notes.png" })).toBe(false);
  });
});

/** An ISO-BMFF `ftyp` box with these brands, followed by undecodable junk. */
function ftyp(major: string, compatible: string[]): Buffer {
  const brands = [major, "\0\0\0\0", ...compatible].join("");
  const size = 8 + brands.length;
  const head = Buffer.alloc(4);
  head.writeUInt32BE(size);
  return Buffer.concat([head, Buffer.from("ftyp" + brands, "latin1"), Buffer.from("junk-after-the-box")]);
}

describe("looksLikeHeif", () => {
  it("recognises an iPhone HEIC by its major brand", () => {
    expect(looksLikeHeif(ftyp("heic", ["mif1", "heic"]))).toBe(true);
  });

  it("recognises a generic HEIF brand with a HEVC compatible brand", () => {
    expect(looksLikeHeif(ftyp("mif1", ["heic"]))).toBe(true);
  });

  it("does not mistake AVIF, which also lists mif1, for HEIC", () => {
    expect(looksLikeHeif(ftyp("avif", ["mif1", "miaf"]))).toBe(false);
  });

  it("does not match a JPEG or a short buffer", () => {
    expect(looksLikeHeif(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]))).toBe(false);
    expect(looksLikeHeif(Buffer.from("ftyp"))).toBe(false);
  });
});
