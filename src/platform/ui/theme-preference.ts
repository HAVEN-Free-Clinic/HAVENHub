import { prisma, isDbUnreachableError } from "@/platform/db";
import { log, errorAttrs } from "@/platform/logging";

/**
 * Resolve a person's stored theme preference for the no-flash <html> class in
 * the root layout. This runs on every authenticated render (before the page's
 * own requirePersonSession) so the theme class is set before any content paints.
 *
 * Because it is on the every-render path, a brief DB outage (server unreachable)
 * must not turn into a site-wide 500 -- the same hazard getSetting guards. It
 * degrades to null (no personal preference); the caller then falls back to the
 * admin default theme, exactly as it does for a session-less visitor, until the
 * DB recovers. Non-connectivity errors still throw.
 */
export async function getPersonThemePreference(personId: string): Promise<string | null> {
  try {
    const person = await prisma.person.findUnique({
      where: { id: personId },
      select: { themePreference: true },
    });
    return person?.themePreference ?? null;
  } catch (err) {
    if (isDbUnreachableError(err)) {
      log.warn(
        "[theme] database unreachable resolving person preference; using default",
        errorAttrs(err)
      );
      return null;
    }
    throw err;
  }
}
