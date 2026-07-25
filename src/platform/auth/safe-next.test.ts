import { expect, it, describe } from "vitest";
import { safeLoginPath, loginRedirectPath } from "./safe-next";

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

describe("loginRedirectPath", () => {
  it("carries a real destination as an encoded callbackUrl", () => {
    expect(loginRedirectPath("/incidents/review")).toBe(
      "/login?callbackUrl=%2Fincidents%2Freview"
    );
  });

  it("returns a bare /login when there is no path context (server actions)", () => {
    expect(loginRedirectPath(null)).toBe("/login");
    expect(loginRedirectPath(undefined)).toBe("/login");
    expect(loginRedirectPath("")).toBe("/login");
  });

  it("returns a bare /login for the home page, which needs no round trip", () => {
    expect(loginRedirectPath("/")).toBe("/login");
  });

  it("drops an off-origin or protocol-relative path rather than echoing it", () => {
    expect(loginRedirectPath("//evil.com")).toBe("/login");
    expect(loginRedirectPath("/\\evil.com")).toBe("/login");
    expect(loginRedirectPath("https://evil.com/x")).toBe("/login");
  });
});
