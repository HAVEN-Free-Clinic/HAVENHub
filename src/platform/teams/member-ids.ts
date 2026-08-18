/**
 * Resolve roster members to the Entra object ids Graph needs to seat them in a
 * chat.
 *
 * The resolved ids are deliberately NOT written back to Person.entraObjectId.
 * That column is the SSO identity link match-person.ts uses to bind a login to a
 * person, and it is @unique: a directory lookup that matched the wrong Ellen
 * Smith would turn a display bug into an account takeover. Looking up fresh
 * costs about twenty cheap directory reads once a week.
 */
import { lookupUserId } from "./group-chat";

/**
 * What this module needs to resolve one person, declared here rather than
 * imported from the schedule module.
 *
 * Structural on purpose: eslint forbids src/platform from importing
 * @/modules (platform must not depend on module internals), and the schedule
 * module's TriageRosterMember already has every field below, so it satisfies
 * this shape with no adapter.
 */
export type ChatMemberCandidate = {
  personId: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  departmentName: string;
  entraObjectId: string | null;
};

export type ResolvedMember<T extends ChatMemberCandidate = ChatMemberCandidate> = {
  member: T;
  userId: string | null;
  source: "stored" | "directory" | "unresolved";
  /** Why the member could not be resolved. Shown to the ED verbatim. */
  reason?: string;
};

/** Yale sign-in names. lookupUserId matches UPN or mail, so either form works. */
function candidates(member: ChatMemberCandidate): string[] {
  const out: string[] = [];
  if (member.netId) out.push(`${member.netId}@yale.edu`);
  if (member.contactEmail) out.push(member.contactEmail);
  return out;
}

/**
 * Bounded parallelism. A roster is about twenty people once a week, so this is
 * not about throughput: it keeps a burst of directory reads from tripping
 * Graph's rate limiter, which would turn one slow week into a page full of
 * unresolved members.
 */
const CONCURRENCY = 5;

export async function resolveMemberIds<T extends ChatMemberCandidate>(
  members: T[],
  deps: { lookup?: (bind: string) => Promise<string | null> } = {},
): Promise<ResolvedMember<T>[]> {
  const lookup = deps.lookup ?? ((bind: string) => lookupUserId(bind));
  const results: ResolvedMember<T>[] = new Array(members.length);

  async function resolveOne(index: number): Promise<void> {
    const member = members[index];
    if (member.entraObjectId) {
      results[index] = { member, userId: member.entraObjectId, source: "stored" };
      return;
    }
    const binds = candidates(member);
    if (binds.length === 0) {
      results[index] = {
        member,
        userId: null,
        source: "unresolved",
        reason: "No Yale net ID or contact email on file to look up.",
      };
      return;
    }
    for (const bind of binds) {
      try {
        const userId = await lookup(bind);
        if (userId) {
          results[index] = { member, userId, source: "directory" };
          return;
        }
      } catch (err) {
        // One person's failed lookup must not sink the batch: the ED still gets
        // a chat with everyone else and a named list of who to add by hand.
        results[index] = {
          member,
          userId: null,
          source: "unresolved",
          reason: err instanceof Error ? err.message : String(err),
        };
        return;
      }
    }
    results[index] = {
      member,
      userId: null,
      source: "unresolved",
      reason: "Not found in the Microsoft directory.",
    };
  }

  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, members.length) }, async () => {
    while (next < members.length) {
      const index = next++;
      await resolveOne(index);
    }
  });
  await Promise.all(workers);
  return results;
}
