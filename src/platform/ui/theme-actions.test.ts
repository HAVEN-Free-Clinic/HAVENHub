import { describe, expect, it, vi, beforeEach } from "vitest";

const { update, cookieSet, requirePersonSession } = vi.hoisted(() => ({
  update: vi.fn(),
  cookieSet: vi.fn(),
  requirePersonSession: vi.fn(),
}));

vi.mock("@/platform/db", () => ({ prisma: { person: { update } } }));
vi.mock("@/platform/auth/session", () => ({ requirePersonSession: () => requirePersonSession() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: cookieSet }) }));

import { setThemePreference } from "./theme-actions";

beforeEach(() => {
  update.mockReset();
  cookieSet.mockReset();
  requirePersonSession.mockReset();
  requirePersonSession.mockResolvedValue({ personId: "p1", name: "Sam", email: null });
});

describe("setThemePreference", () => {
  it("persists a valid preference and mirrors it to a cookie", async () => {
    await setThemePreference("dark");
    expect(update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { themePreference: "dark" } });
    expect(cookieSet).toHaveBeenCalledWith(
      expect.objectContaining({ name: "theme-pref", value: "dark", path: "/", sameSite: "lax" }),
    );
  });

  it("rejects an invalid preference without touching the DB", async () => {
    await expect(setThemePreference("rainbow" as never)).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("does not touch the DB when auth fails", async () => {
    requirePersonSession.mockRejectedValue(new Error("Unauthenticated"));
    await expect(setThemePreference("dark")).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
});
