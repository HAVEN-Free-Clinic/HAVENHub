import { Badge } from "./badge";

/**
 * Whether a person directs a department or volunteers in it, said the same way
 * everywhere.
 *
 * Six surfaces answered this and each answered it in its own colour. The worst
 * pair was on ONE page: the schedule builder's Day view drew a director's chip
 * brand-toned and its Availability view drew the same person's grey, so
 * toggling the tab recoloured them. /volunteers, /volunteers/directory, the
 * admin memberships panel, the term roster editor and a member's own
 * memberships card each carried their own copy of the ternary.
 *
 * A shared component rather than an inline Badge per site, for the same reason
 * ActiveBadge is one: this is the smallest possible vocabulary (two words, two
 * tones) and it is precisely the kind that drifts one page at a time.
 *
 * No "use client", no hooks, no refs. Half the call sites are server components
 * (/volunteers, the roster panel) and half are client (the builder views), so
 * it has to be plain.
 *
 * `MembershipKind` is the string union rather than Prisma's `Track`: platform/ui
 * carries no prisma import anywhere, and the schedule services already hand
 * these values around as this exact union.
 */
export type MembershipKind = "DIRECTOR" | "VOLUNTEER";

/** The same word the badge renders, for prose that names a seat's role. */
export function membershipKindLabel(kind: MembershipKind): string {
  return kind === "DIRECTOR" ? "Director" : "Volunteer";
}

export function MembershipKindBadge({
  kind,
  abbreviated = false,
}: {
  kind: MembershipKind;
  /**
   * Render "Dir"/"Vol" instead of the full word. For the builder grid, whose
   * date columns are ~52px: the chip has to be the short one there, and the
   * detail lives on the Day and availability views, which have room for it.
   *
   * A prop rather than a caller className, per the house rule: the tone must not
   * be reachable from outside, or the sixth rendering simply comes back.
   */
  abbreviated?: boolean;
}) {
  return (
    <Badge tone={kind === "DIRECTOR" ? "brand" : "default"}>
      {abbreviated ? (kind === "DIRECTOR" ? "Dir" : "Vol") : membershipKindLabel(kind)}
    </Badge>
  );
}
