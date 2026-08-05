export type IdentityInput = {
  /** Caller-owned handle (the source record id). Returned in memberKeys. */
  key: string;
  firstName: string;
  lastName: string;
  email: string | null;
  netId: string | null;
};

export type ResolvedIdentity = {
  netId: string | null;
  primaryEmail: string;
  firstName: string;
  lastName: string;
  emails: string[];
  memberKeys: string[];
};

/**
 * Union-find over the netId and email edges of every extracted row, run as one
 * batch before any write.
 *
 * Batch rather than incremental because merges are discovered out of order: a
 * row carrying only email A and a row carrying only netId X look unrelated
 * until a third row carrying BOTH arrives, at which point the first two must
 * retroactively become one person. An incremental resolver would already have
 * written them as two.
 */
export function resolveIdentities(rows: IdentityInput[]): ResolvedIdentity[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(x) !== root) {
      const next = parent.get(x)!;
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  const add = (x: string) => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a: string, b: string) => { parent.set(find(a), find(b)); };

  const usable = rows
    .map((r) => ({
      ...r,
      email: r.email?.trim().toLowerCase() || null,
      netId: r.netId?.trim().toLowerCase() || null,
    }))
    .filter((r) => r.email || r.netId);

  // Node namespacing keeps an email that happens to equal a netId from joining
  // two unrelated people.
  for (const r of usable) {
    const self = `row:${r.key}`;
    add(self);
    if (r.email) { add(`email:${r.email}`); union(self, `email:${r.email}`); }
    if (r.netId) { add(`netid:${r.netId}`); union(self, `netid:${r.netId}`); }
  }

  const clusters = new Map<string, typeof usable>();
  for (const r of usable) {
    const root = find(`row:${r.key}`);
    const bucket = clusters.get(root) ?? [];
    bucket.push(r);
    clusters.set(root, bucket);
  }

  return [...clusters.values()].map((members) => {
    const emails = [...new Set(members.map((m) => m.email).filter((e): e is string => Boolean(e)))];
    const netId = members.find((m) => m.netId)?.netId ?? null;
    // Prefer a yale.edu address as the display primary; fall back to the first.
    const primaryEmail = emails.find((e) => e.endsWith("@yale.edu")) ?? emails[0];
    const named = members.find((m) => m.firstName || m.lastName) ?? members[0];
    return {
      netId,
      primaryEmail,
      firstName: named.firstName,
      lastName: named.lastName,
      emails,
      memberKeys: members.map((m) => m.key),
    };
  }).filter((identity) => Boolean(identity.primaryEmail));
}
