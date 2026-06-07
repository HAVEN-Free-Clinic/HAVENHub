/**
 * MembershipsCard: shows the signed-in member's current-term memberships.
 *
 * - Lists each ACTIVE membership with dept code + kind badge.
 * - Volunteers (ACTIVE VOLUNTEER kind) get a "I am not volunteering this term"
 *   ConfirmButton that submits a server action.
 * - Director rows show a note directing members to contact the EDs instead of
 *   a withdraw button.
 * - When the list is empty (alumni, no current term): a quiet message.
 */

import type { TermMembership, Department, Term } from "@prisma/client";
import { Badge } from "@/platform/ui/badge";
import { ConfirmButton } from "@/platform/ui/confirm-button";

type MembershipWithRelations = TermMembership & {
  department: Department;
  term: Term;
};

type MembershipsCardProps = {
  memberships: MembershipWithRelations[];
  withdrawAction: (formData: FormData) => Promise<void>;
  withdrawn?: number;
};

export function MembershipsCard({
  memberships,
  withdrawAction,
  withdrawn,
}: MembershipsCardProps) {
  const hasVolunteer = memberships.some((m) => m.kind === "VOLUNTEER");
  const hasDirector = memberships.some((m) => m.kind === "DIRECTOR");

  return (
    <div>
      {withdrawn !== undefined && withdrawn > 0 && (
        <p className="mb-3 text-sm text-success">
          Withdrawn from {withdrawn} volunteer assignment{withdrawn !== 1 ? "s" : ""} this term.
        </p>
      )}

      {memberships.length === 0 ? (
        <p className="text-sm text-slate-400">No current-term assignments.</p>
      ) : (
        <ul className="space-y-2">
          {memberships.map((m) => (
            <li key={m.id} className="flex items-center gap-2 text-sm">
              <span className="font-medium text-slate-700">{m.department.code}</span>
              {m.kind === "DIRECTOR" ? (
                <Badge tone="brand">Director</Badge>
              ) : (
                <Badge tone="default">Volunteer</Badge>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Volunteer withdraw button */}
      {hasVolunteer && (
        <form action={withdrawAction} className="mt-4">
          <ConfirmButton
            label="I am not volunteering this term"
            confirmLabel="Confirm withdrawal?"
          />
        </form>
      )}

      {/* Director note */}
      {hasDirector && (
        <p className="mt-3 text-sm text-slate-500">
          To step down as a director, contact the executive directors.
        </p>
      )}
    </div>
  );
}
