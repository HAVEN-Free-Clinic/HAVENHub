/** The three values a theme preference may take. */
export const THEME_VALUES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEME_VALUES)[number];

/** Cookie mirroring the user's preference. The server reads it to populate {@link THEME_ATTR} for the no-flash render. */
export const THEME_COOKIE = "theme-pref";

/** `<html>` attribute holding the resolved preference; the no-flash script and client components read it. Populated server-side from {@link THEME_COOKIE} / the DB. */
export const THEME_ATTR = "data-theme-pref";

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_VALUES as readonly string[]).includes(value);
}

/** Person preference (DB) wins; else the admin default; else "system". */
export function resolvePreference(
  personPref: string | null | undefined,
  adminDefault: string | null | undefined,
): ThemePreference {
  if (isThemePreference(personPref)) return personPref;
  if (isThemePreference(adminDefault)) return adminDefault;
  return "system";
}

/** The class to put on <html>: "dark", or "" for light. Tailwind dark mode keys off the presence/absence of the `dark` class, so light is the empty string rather than "light". System resolves via the OS flag. */
export function effectiveClass(pref: ThemePreference, prefersDark: boolean): "dark" | "" {
  if (pref === "dark") return "dark";
  if (pref === "light") return "";
  return prefersDark ? "dark" : "";
}

/**
 * The blocking inline <head> script. Explicit light/dark are already applied
 * server-side via the <html> class, so this only needs to resolve "system"
 * against the OS before first paint.
 */
export function buildNoFlashScript(): string {
  return (
    "(function(){try{" +
    "var p=document.documentElement.getAttribute('" + THEME_ATTR + "');" +
    "if(p==='system'){" +
    "var d=window.matchMedia('(prefers-color-scheme: dark)').matches;" +
    "document.documentElement.classList.toggle('dark',d);" +
    "}}catch(e){}})();"
  );
}
