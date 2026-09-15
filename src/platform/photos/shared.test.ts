import { describe, expect, it } from "vitest";
import { photoUrl, isHeic } from "./shared";

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
