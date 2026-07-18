import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getAccessToken } from "@/platform/email/oauth";

type Db = PrismaClient | Prisma.TransactionClient;

export interface ResolveIdentityDeps {
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Returns a valid delegated Graph token. Defaults to the mailer token. */
  getToken?: () => Promise<string>;
}

/**
 * Resolve a person's Entra user id for Teams delivery.
 *
 * Uses Person.entraObjectId when present. Otherwise looks the user up by
 * contactEmail via Graph (GET /users/{email}?$select=id) and caches the id back
 * onto the Person row so future sends skip the lookup. Returns null when no
 * identity can be resolved (no entra id, no email, or a failed/!ok lookup).
 * Never throws.
 *
 * The cache write is performed on the provided `db` handle (defaulting to the
 * global client). notify() passes its transaction handle so the write JOINS the
 * caller's transaction rather than racing it on a separate pooled connection,
 * which previously risked a lock cycle (caller tx holds the Person row, this
 * write waits on it, the caller waits on this write) when notify() runs inside a
 * transaction.
 */
export async function resolveTeamsUser(
  person: { id: string; entraObjectId: string | null; contactEmail: string | null },
  deps: ResolveIdentityDeps = {},
  db: Db = prisma
): Promise<string | null> {
  if (person.entraObjectId) return person.entraObjectId;
  if (!person.contactEmail) return null;

  const { fetchImpl = fetch, getToken = getAccessToken } = deps;
  try {
    const token = await getToken();
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
      person.contactEmail
    )}?$select=id`;
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      // Bound the Graph lookup so a hang converts to the graceful null path (notify()
      // awaits this inline in user actions) instead of blocking to the function limit.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { id?: string };
    if (!json.id) return null;
    await db.person.update({
      where: { id: person.id },
      data: { entraObjectId: json.id },
    });
    return json.id;
  } catch {
    return null;
  }
}
