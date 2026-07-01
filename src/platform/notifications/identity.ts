import { prisma } from "@/platform/db";
import { getAccessToken } from "@/platform/email/oauth";

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
 */
export async function resolveTeamsUser(
  person: { id: string; entraObjectId: string | null; contactEmail: string | null },
  deps: ResolveIdentityDeps = {}
): Promise<string | null> {
  if (person.entraObjectId) return person.entraObjectId;
  if (!person.contactEmail) return null;

  const { fetchImpl = fetch, getToken = getAccessToken } = deps;
  try {
    const token = await getToken();
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
      person.contactEmail
    )}?$select=id`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const json = (await res.json()) as { id?: string };
    if (!json.id) return null;
    await prisma.person.update({
      where: { id: person.id },
      data: { entraObjectId: json.id },
    });
    return json.id;
  } catch {
    return null;
  }
}
