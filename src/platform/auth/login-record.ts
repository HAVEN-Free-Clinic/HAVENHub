import { prisma } from "@/platform/db";
import { log, errorAttrs } from "@/platform/logging";

/**
 * Only the piece of Headers this needs, so callers can inject a plain object in
 * tests instead of standing up a request.
 */
type HeaderBag = { get(name: string): string | null };

/**
 * Vercel percent-encodes the geo headers, so "New Haven" arrives as
 * "New%20Haven". A malformed value makes decodeURIComponent throw (a bare "%"
 * is enough), and a login is not worth losing over a city name, so the raw
 * value stands in that case.
 */
function decodeHeader(value: string | null): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Stamps the most recent sign-in on the person: when, what browser, and roughly
 * where.
 *
 * BEST-EFFORT, AND THAT IS THE POINT. This runs on the sign-in path, so every
 * failure is swallowed and logged rather than propagated. A volunteer locked out
 * of the app because a geo header was malformed or Neon blinked would be far
 * worse than a missing timestamp. Callers must not depend on it having written.
 *
 * Last value only, never a history: enough to tell a dormant account from an
 * active one, and to answer "what browser are they on" when triaging a ticket,
 * without accumulating a movement log of a student volunteer. City and country
 * only, never an IP.
 *
 * The geo headers come from Vercel's edge and are absent everywhere else, so in
 * local development the location fields are null by design, not by failure.
 */
export async function recordLoginContext(personId: string, headers: HeaderBag): Promise<void> {
  try {
    await prisma.person.update({
      where: { id: personId },
      data: {
        lastLoginAt: new Date(),
        lastLoginUserAgent: headers.get("user-agent"),
        lastLoginCity: decodeHeader(headers.get("x-vercel-ip-city")),
        lastLoginCountry: headers.get("x-vercel-ip-country"),
      },
    });
  } catch (err) {
    log.warn("[auth] failed to record login context (best-effort)", errorAttrs(err));
  }
}
