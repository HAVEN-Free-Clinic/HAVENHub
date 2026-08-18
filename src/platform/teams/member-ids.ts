/**
 * Resolve roster members to the Entra object ids Graph needs to seat them in a
 * chat.
 *
 * Person.entraObjectId is the only source. It is populated for free at SSO
 * login (auth.ts reads the oid claim, match-person.ts links it), so anyone who
 * has signed into the Hub resolves without a Graph call.
 *
 * There is deliberately no directory-lookup fallback for the rest. Resolving a
 * name against the directory would cost User.ReadBasic.All -- a tenant-wide read
 * of every Yale account -- to seat the shrinking set of people who are in the
 * Entra tenant but have never signed in. Non-Yale members are not in the tenant
 * at all, so no lookup could ever place them either way. Unresolved members are
 * named for the ED to add by hand.
 */

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
  source: "stored" | "unresolved";
  /** Why the member could not be resolved. Shown to the ED verbatim. */
  reason?: string;
};

export function resolveMemberIds<T extends ChatMemberCandidate>(
  members: T[],
): ResolvedMember<T>[] {
  return members.map((member) =>
    member.entraObjectId
      ? { member, userId: member.entraObjectId, source: "stored" as const }
      : {
          member,
          userId: null,
          source: "unresolved" as const,
          // Phrased as the action the ED can take. "Not in the directory" would
          // be wrong for the common case: the person exists at Yale, they just
          // have not signed into the Hub, which is what links the account.
          reason: "Has not signed in to the Hub yet, so add them by hand.",
        },
  );
}
