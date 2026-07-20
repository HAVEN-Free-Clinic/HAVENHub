import type { Term } from "@prisma/client";

export type TermOption = { value: string; label: string };

/**
 * Options for the role-assignment Term <select>, restricted to scopes the RBAC
 * engine actually honors. getEffectivePermissions (platform/rbac/engine.ts) only
 * counts assignments scoped to null (Global) or the active term, so:
 *  - "Global" (null scope) is always offered first
 *  - the ACTIVE term is offered with a plain label (it confers access now)
 *  - PLANNING terms are offered but flagged "(not yet active)"; the assignment
 *    is forward-dated and confers nothing until that term is activated
 *  - ARCHIVED terms are omitted by default: an assignment scoped to one is
 *    permanently inert and can never be honored again
 *
 * This keeps the picker consistent with enforced access; without it an admin can
 * create assignments that look valid in the table but grant nothing.
 *
 * Pass `{ includeArchived: true }` to append archived terms anyway, labeled
 * "{code} (archived)" — used by read-only pickers (e.g. the schedule builder's
 * TermSwitcher) where viewing a past term's data is legitimate even though no
 * RBAC assignment can be scoped to it. The default (no opts) is unchanged, so
 * existing callers like the RBAC role-assignment picker are unaffected.
 */
export function buildTermOptions(
  terms: Pick<Term, "id" | "code" | "status">[],
  opts: { includeArchived?: boolean } = {},
): TermOption[] {
  const options: TermOption[] = [{ value: "", label: "Global" }];
  for (const t of terms) {
    if (t.status === "ARCHIVED") {
      if (opts.includeArchived) options.push({ value: t.id, label: `${t.code} (archived)` });
      continue;
    }
    const label = t.status === "PLANNING" ? `${t.code} (not yet active)` : t.code;
    options.push({ value: t.id, label });
  }
  return options;
}
