import { prisma } from "@/platform/db";
import { resolveFeedToken, touchFeedToken } from "@/modules/schedule/calendar/feed-token";
import { renderFeedForPerson, renderEmptyFeed } from "@/modules/schedule/calendar/feed";
import { log, errorAttrs } from "@/platform/logging";

type RouteContext = { params: Promise<{ token: string }> };

export const dynamic = "force-dynamic";

// Coarse per-IP flood backstop, mirroring the in-memory limiter in
// member-magic-link.ts. This is not access control: the token is. Sized loosely
// because Google, Apple, and Outlook all poll from wide, shared address pools,
// so a legitimate burst from one address is normal.
const IP_RATE_WINDOW_MS = 15 * 60 * 1000;
const IP_RATE_MAX = 120;
const ipHits = new Map<string, number[]>();

function ipRateLimited(ip: string | null): boolean {
  if (!ip) return false;
  const now = Date.now();
  // Bound the map so a churn of addresses cannot grow it without limit.
  if (ipHits.size > 5000) ipHits.clear();
  const recent = (ipHits.get(ip) ?? []).filter((t) => t > now - IP_RATE_WINDOW_MS);
  if (recent.length >= IP_RATE_MAX) {
    ipHits.set(ip, recent);
    return true;
  }
  recent.push(now);
  ipHits.set(ip, recent);
  return false;
}

const CALENDAR_HEADERS = {
  "Content-Type": "text/calendar; charset=utf-8",
  "Content-Disposition": 'inline; filename="haven-shifts.ics"',
  // Per-person secret. Must never land in a shared cache.
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

/**
 * GET /api/calendar/[token] -- personal shift feed for calendar clients.
 *
 * Unauthenticated by design: Google and Apple fetch this from their own
 * servers and cannot carry a session. The path token is the credential.
 *
 * A member who is no longer ACTIVE gets a valid but empty calendar rather than
 * a 404, so an offboarded member's calendar goes quiet instead of surfacing a
 * persistent broken-calendar error in a client they may never open again.
 * Access stops either way.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const clientIp = forwardedFor ? forwardedFor.split(",")[0]!.trim() : null;
  if (ipRateLimited(clientIp)) {
    return new Response("Too many requests", { status: 429 });
  }

  const { token } = await context.params;
  // Clients are given a .ics-suffixed URL so they sniff the type correctly;
  // accept the bare form too.
  const raw = token.endsWith(".ics") ? token.slice(0, -4) : token;

  const match = await resolveFeedToken(raw);
  if (!match) {
    return new Response("Not found", { status: 404 });
  }

  const person = await prisma.person.findUnique({
    where: { id: match.personId },
    select: { status: true },
  });

  if (person?.status !== "ACTIVE") {
    return new Response(await renderEmptyFeed(), { status: 200, headers: CALENDAR_HEADERS });
  }

  const body = await renderFeedForPerson(match.personId);

  // Best effort: the fetch-timestamp bookkeeping must never block or fail the
  // response. A subscriber's calendar client polls this unattended, and a
  // transient write blip here is not their problem -- their shifts already
  // rendered successfully above.
  void touchFeedToken(match.personId).catch((err: unknown) => {
    log.warn("[calendar-feed] failed to record feed fetch", errorAttrs(err, { personId: match.personId }));
  });

  return new Response(body, { status: 200, headers: CALENDAR_HEADERS });
}
