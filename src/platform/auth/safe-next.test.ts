import { expect, it } from "vitest";
import { safeLoginPath } from "./safe-next";

it("accepts same-origin slash-rooted paths and rejects the rest", () => {
  expect(safeLoginPath("/dashboard")).toBe("/dashboard");
  expect(safeLoginPath("/incidents?tab=open")).toBe("/incidents?tab=open");
  expect(safeLoginPath(null)).toBe("/");
  expect(safeLoginPath("")).toBe("/");
  expect(safeLoginPath("//evil.com")).toBe("/");
  expect(safeLoginPath("/\\evil.com")).toBe("/");
  expect(safeLoginPath("https://evil.com/x")).toBe("/");
  expect(safeLoginPath("javascript:alert(1)")).toBe("/");
});
