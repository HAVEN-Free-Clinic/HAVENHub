import { expect, it } from "vitest";
import { safeNextPath } from "./portal-next";

it("keeps a same-origin, slash-rooted path", () => {
  expect(safeNextPath("/apply/spring-2026")).toBe("/apply/spring-2026");
  expect(safeNextPath("/apply/spring-2026?type=renewal")).toBe("/apply/spring-2026?type=renewal");
});

it("rejects protocol-relative and absolute URLs (no open redirect)", () => {
  expect(safeNextPath("//evil.com")).toBe("/apply");
  expect(safeNextPath("https://evil.com")).toBe("/apply");
  expect(safeNextPath("http://evil.com")).toBe("/apply");
});

it("rejects backslash-rooted paths some browsers treat as protocol-relative", () => {
  expect(safeNextPath("/\\evil.com")).toBe("/apply");
});

it("rejects paths that are not slash-rooted", () => {
  expect(safeNextPath("apply/spring-2026")).toBe("/apply");
  expect(safeNextPath("javascript:alert(1)")).toBe("/apply");
});

it("falls back to /apply for empty, root-only, or missing values", () => {
  expect(safeNextPath("/")).toBe("/apply");
  expect(safeNextPath("")).toBe("/apply");
  expect(safeNextPath(null)).toBe("/apply");
  expect(safeNextPath(undefined)).toBe("/apply");
});
