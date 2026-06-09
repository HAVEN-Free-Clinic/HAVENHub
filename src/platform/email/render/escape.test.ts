import { describe, expect, it } from "vitest";
import { esc } from "./escape";

describe("esc", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(esc(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;",
    );
  });

  it("escapes ampersand first so entities are not double-built", () => {
    expect(esc("<")).toBe("&lt;");
    expect(esc("&lt;")).toBe("&amp;lt;");
  });

  it("returns an empty string unchanged", () => {
    expect(esc("")).toBe("");
  });
});
