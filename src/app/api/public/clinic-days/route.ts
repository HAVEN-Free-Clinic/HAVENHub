import { isDbUnreachableError, isSchemaMissingError } from "@/platform/db";
import { publicClinicDays } from "@/platform/terms/public-clinic-days";
import { log, errorAttrs } from "@/platform/logging";

export const dynamic = "force-dynamic";

/** How many upcoming days to return by default; the website renders four cards. */
const DEFAULT_LIMIT = 4;

/** Ceiling on ?limit=, so one request cannot ask for a term's whole calendar. */
const MAX_LIMIT = 26;

/**
 * Shared cache and CORS headers.
 *
 * CACHING. s-maxage lets Vercel's CDN answer almost every hit without waking a
 * function or touching Neon, which is what keeps an endpoint anyone may call from
 * being a load concern. Five minutes is far tighter than the data actually
 * changes (a director editing the term calendar is a once-a-week event at most),
 * and stale-while-revalidate means the one request that finds the entry expired
 * still gets an instant answer.
 *
 * CORS is `*` deliberately, and it is worth being explicit about why rather than
 * reflexively pinning an origin. CORS restricts *browser* JavaScript; it is not
 * access control, and anyone can read this with curl regardless of what is set
 * here. Everything in the response is already published on a public web page, and
 * no cookie or credential is involved, so pinning an origin would buy no
 * security. It would cost two real things: a `Vary: Origin` that fragments the
 * CDN cache, and a deploy-time value that silently blanks the schedule on the
 * website the day the site moves domain or adds a preview host. If a future
 * response ever carries something non-public, this is the line that has to change
 * first -- but the right fix then is to not put it in this response.
 */
const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
};

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number(raw);
  // Reject NaN, zero, negatives, and fractions rather than coercing them: a
  // caller who sent nonsense gets the documented default, not a surprise.
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * GET /api/public/clinic-days -- the clinic's upcoming open Saturdays.
 *
 * Unauthenticated and public by design: it feeds the "Upcoming Clinic Days"
 * section on havenfreeclinic.org, which is a static site on GitHub Pages with no
 * server of its own to proxy through, so the fetch happens in a visitor's
 * browser and cannot carry a credential. This replaces a hand-kept Airtable
 * table that the website read with an Airtable token embedded in its client
 * bundle, so the token is retired along with it.
 *
 * The response contains calendar dates and the name of the rotating specialty
 * clinic, and nothing else. See platform/terms/public-clinic-days.ts for what is
 * deliberately excluded and why.
 *
 * Response: { "clinicDays": [ { "date": "2026-08-22", "specialty": "Dermatology" } ] }
 * Query:    ?limit=<1..26>, default 4.
 */
export async function GET(request: Request): Promise<Response> {
  const limit = parseLimit(new URL(request.url).searchParams.get("limit"));

  try {
    const clinicDays = await publicClinicDays(limit);
    return new Response(JSON.stringify({ clinicDays }), { status: 200, headers: HEADERS });
  } catch (err) {
    // Same reasoning as the calendar feed: this is polled unattended by browsers
    // we do not control, so a Neon blip should degrade to a status their retry
    // path expects instead of surfacing a 500. The website already renders a
    // "call for the latest schedule" fallback when the fetch fails, so a 503 is
    // visibly harmless to a patient while staying loud in monitoring.
    if (isDbUnreachableError(err) || isSchemaMissingError(err)) {
      log.warn("[public-clinic-days] database unavailable serving schedule", errorAttrs(err));
      return new Response(JSON.stringify({ error: "unavailable" }), {
        status: 503,
        headers: { ...HEADERS, "Cache-Control": "no-store" },
      });
    }
    throw err;
  }
}

/**
 * Preflight. A simple cross-origin GET does not trigger one, so this exists for
 * the case where a caller adds a header that makes the request non-simple, rather
 * than for the website's own fetch.
 */
export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
    },
  });
}
