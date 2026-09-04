/**
 * MembershipsCard: shows the signed-in member's current-term memberships.
 *
 * - Lists each ACTIVE membership with dept code + kind badge.
 * - Volunteers (ACTIVE VOLUNTEER kind) get an optional reason field and an
 *   "I am not volunteering this term" ConfirmButton that submits a server action.
 *   The reason rides along to the offboarding managers who get alerted.
 * - Director rows show a note directing members to contact the EDs instead of
 *   a withdraw button.
 * - When the list is empty (alumni, no current term): a quiet message.
 */

import type { TermMembership, Department, Term } from "@prisma/client";
import { Card } from "@/platform/ui/card";
import { Badge } from "@/platform/ui/badge";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { FormActions } from "@/platform/ui/form";
import { Input } from "@/platform/ui/input";
import { WithdrawnToast } from "./withdrawn-toast";
import { EmptyState } from "@/platform/ui/empty-state";

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
    <Card>
      <WithdrawnToast withdrawn={withdrawn} />

      {memberships.length === 0 ? (
        <EmptyState inline>No current-term assignments.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {memberships.map((m) => (
            <li key={m.id} className="flex items-center gap-2 text-sm">
              <span className="font-medium text-foreground-soft">{m.department.code}</span>
              {m.kind === "DIRECTOR" ? (
                <Badge tone="brand">Director</Badge>
              ) : (
                <Badge tone="default">Volunteer</Badge>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Volunteer withdraw button, with an optional reason for the offboarding alert */}
      {hasVolunteer && (
        <form action={withdrawAction} className="mt-4">
          <FormActions className="flex-wrap">
            <Input
              name="reason"
              placeholder="Reason (optional)"
              aria-label="Reason for not volunteering (optional)"
              maxLength={300}
              className="max-w-56"
            />
            <ConfirmButton
              label="I am not volunteering this term"
              confirmLabel="Confirm withdrawal?"
            />
          </FormActions>
        </form>
      )}

      {/* Director note */}
      {hasDirector && (
        <p className="mt-3 text-sm text-muted-foreground">
          To step down as a director, contact the executive directors.
        </p>
      )}
    </Card>
  );
}
