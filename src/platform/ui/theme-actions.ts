"use server";

import { cookies } from "next/headers";
import { prisma } from "@/platform/db";
import { requirePersonSession } from "@/platform/auth/session";
import { isThemePreference, THEME_COOKIE, type ThemePreference } from "./theme";

/** Persist the signed-in user's theme choice and mirror it to the no-flash cookie. */
export async function setThemePreference(pref: ThemePreference): Promise<void> {
  if (!isThemePreference(pref)) throw new Error(`Invalid theme preference: ${String(pref)}`);
  const { personId } = await requirePersonSession();
  await prisma.person.update({ where: { id: personId }, data: { themePreference: pref } });
  const store = await cookies();
  store.set({
    name: THEME_COOKIE,
    value: pref,
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
}
