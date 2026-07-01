import type { Track } from "@prisma/client";
import { prisma } from "@/platform/db";

export type RenewalContext = {
  personId: string;
  name: string | null;
  email: string | null;
  netId: string | null;
  phone: string | null;
  currentDepartments: string[];
  eligible: boolean;
};

/**
 * Eligibility + identity for a returning applicant. `kind` is the cycle's track
 * (VOLUNTEER or DIRECTOR): a returning director renews against their director
 * membership, a returning volunteer against their volunteer membership. `email`
 * is the verified session (Entra) address, returned verbatim, never read from
 * Person.contactEmail. Departments are the codes from the person's active
 * memberships of that kind in their most-recent term (by term.startDate).
 */
export async function getRenewalContext(personId: string, sessionEmail: string | null, kind: Track): Promise<RenewalContext> {
  const person = await prisma.person.findUnique({
    where: { id: personId },
    include: {
      memberships: {
        where: { kind, status: "ACTIVE" },
        include: { term: { select: { startDate: true } }, department: { select: { code: true } } },
      },
    },
  });
  if (!person) {
    return { personId, name: null, email: sessionEmail, netId: null, phone: null, currentDepartments: [], eligible: false };
  }
  let latest = 0;
  for (const m of person.memberships) latest = Math.max(latest, m.term.startDate.getTime());
  const currentDepartments = latest
    ? Array.from(new Set(person.memberships.filter((m) => m.term.startDate.getTime() === latest).map((m) => m.department.code)))
    : [];
  return {
    personId,
    name: person.name,
    email: sessionEmail,
    netId: person.netId,
    phone: person.phone,
    currentDepartments,
    eligible: currentDepartments.length > 0,
  };
}

/**
 * Maps a renewal context onto a cycle's field keys. Uses the guaranteed identity
 * keys plus field semantics (the same conventions submissions.ts relies on).
 * Fields that match nothing are left unset (off-convention forms simply do not
 * prefill). Department is handled by the form's renewal-department control.
 */
export function resolveRenewalPrefill(
  fields: { key: string; type: string }[],
  ctx: RenewalContext,
): { values: Record<string, string>; lockedKeys: string[] } {
  const values: Record<string, string> = {};
  const lockedKeys: string[] = [];

  const name = (ctx.name ?? "").trim();
  if (name) {
    const sp = name.indexOf(" ");
    values.first_name = sp === -1 ? name : name.slice(0, sp);
    values.last_name = sp === -1 ? "" : name.slice(sp + 1).trim();
  }

  for (const f of fields) {
    if ((f.type === "EMAIL" || f.key === "email") && ctx.email) {
      values[f.key] = ctx.email;
      lockedKeys.push(f.key);
    } else if ((f.type === "PHONE" || f.key === "phone") && ctx.phone) {
      values[f.key] = ctx.phone;
    } else if (f.key === "netid" && ctx.netId) {
      values[f.key] = ctx.netId;
    }
  }
  return { values, lockedKeys };
}
