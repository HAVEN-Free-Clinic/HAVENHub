import { auth } from "@/platform/auth/auth";
import { isDbUnreachableError } from "@/platform/db";
import { getActivePerson } from "@/platform/auth/match-person";
import { log, errorAttrs } from "@/platform/logging";
import { searchEntities } from "@/modules/search/entities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Permission-scoped search over people, recruitment cycles, and support
 * requests. Page results are resolved client-side from data the nav already
 * holds and never reach this route.
 *
 * The identity used for scoping is ALWAYS the session's personId. A client
 * cannot pass one in; that is the whole security boundary. getActivePerson
 * stays inside the try block because it is the revocation check, and a DB blip
 * must never resolve it as "still active".
 */
export async function GET(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.personId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const q = new URL(request.url).searchParams.get("q") ?? "";
  try {
    const person = await getActivePerson(session.personId);
    if (!person) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const results = await searchEntities(person.id, q);
    return Response.json({ results });
  } catch (err) {
    if (isDbUnreachableError(err)) {
      // Mirrors the notifications poll: degrade rather than turn one Neon blip
      // into a burst of captured exceptions. The palette keeps its page results.
      return Response.json({ error: "Search unavailable" }, { status: 503 });
    }
    log.error("search failed", errorAttrs(err));
    throw err;
  }
}
