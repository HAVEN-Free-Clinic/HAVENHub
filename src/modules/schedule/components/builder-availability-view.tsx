import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Checkbox } from "@/platform/ui/checkbox";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { isoDateKey } from "@/platform/dates";
import { displayDate } from "@/modules/schedule/engine/display";
import { compareBuilderMembers } from "@/modules/schedule/services/builder";
import type { builderView } from "@/modules/schedule/services/builder";
import { IntakeNotes } from "./intake-notes";
import { sortClinicDates } from "./clinic-date-order";
import { BUILDER_AVAILABILITY_PILL_CLASS } from "./availability-pill";

// ---------------------------------------------------------------------------
// Availability mode sub-view
// ---------------------------------------------------------------------------

export type BuilderAvailabilityViewProps = {
  members: Awaited<ReturnType<typeof builderView>>["members"];
  clinicDates: Date[];
  /** Archived (non-live/next) terms are read-only: hide the override/acknowledge forms. */
  editable: boolean;
  saveOverrideAction: (fd: FormData) => Promise<void>;
  clearOverrideAction: (fd: FormData) => Promise<void>;
  acknowledgeAction: (fd: FormData) => Promise<void>;
};

export function BuilderAvailabilityView({
  members,
  clinicDates,
  editable,
  saveOverrideAction,
  clearOverrideAction,
  acknowledgeAction,
}: BuilderAvailabilityViewProps) {
  // `clinicDates` is Term.clinicDates, handed to this component (and its
  // siblings in the same Builder request) by reference: it carries no
  // ordering guarantee, and the check-in feature's seed appends today's date
  // to the end regardless of where it falls chronologically. Sort a copy for
  // the checkbox order below; never the prop itself, or every other consumer
  // of this same array in the request would see it reordered too.
  const sortedClinicDates = sortClinicDates(clinicDates);

  return (
    <div className="flex flex-col gap-4">
      {members.length === 0 && (
        <p className="text-sm text-subtle-foreground">No members in this department.</p>
      )}
      {/* Directors first, then volunteers, alphabetical within each group. */}
      {[...members].sort(compareBuilderMembers).map((member) => {
        const tierLabel =
          member.availability.tier === "DIRECTOR"
            ? "Director override"
            : member.availability.tier === "SELF"
            ? "Self-reported"
            : "Application";

        const tierTone: "brand" | "default" | "warning" =
          member.availability.tier === "DIRECTOR"
            ? "brand"
            : member.availability.tier === "SELF"
            ? "default"
            : "warning";

        const availKeys = new Set(member.availability.dates.map((d) => isoDateKey(d)));

        return (
          <Card key={member.membershipId} pad={false} className="px-4 py-4">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="text-sm font-bold text-foreground">{member.person.name}</span>
              <Badge tone="default">{member.kind === "DIRECTOR" ? "Director" : "Volunteer"}</Badge>
              <Badge tone={tierTone}>{tierLabel}</Badge>
              {member.acknowledgePending && <Badge tone="warning">Availability updated</Badge>}
            </div>
            {member.legacyNote && (
              <p className="mb-3 text-xs text-subtle-foreground italic">{member.legacyNote}</p>
            )}
            <IntakeNotes intake={member.intake} className="mb-3" />
            {editable ? (
              <>
                {/* Key on the server availability signature (tier + dates) so a
                    save/clear soft nav REMOUNTS the form and the uncontrolled
                    defaultChecked boxes re-read the new state -- otherwise "Clear
                    override" left the director's old ticks showing (#9). The key is
                    stable while they tick boxes pre-save (availKeys is server state),
                    so in-progress edits are not lost. */}
                <form
                  key={`${member.availability.tier}:${[...availKeys].sort().join(",")}`}
                  action={saveOverrideAction}
                  className="mb-2"
                >
                  <input type="hidden" name="membershipId" value={member.membershipId} />
                  <div className="flex flex-wrap gap-2 mb-3">
                    {sortedClinicDates.map((d) => {
                      const key = isoDateKey(d);
                      const checked = availKeys.has(key);
                      return (
                        // Styling comes from the live checkbox, not from `checked`:
                        // `checked` only seeds the initial state. See availability-pill.ts.
                        <label key={key} className={BUILDER_AVAILABILITY_PILL_CLASS}>
                          <Checkbox
                            name="dates"
                            value={key}
                            defaultChecked={checked}
                          />
                          {displayDate(key)}
                        </label>
                      );
                    })}
                  </div>
                  <Button type="submit" variant="outline" size="sm">Save override</Button>
                </form>
                {member.overrideActive && (
                  <form action={clearOverrideAction} className="inline mr-2">
                    <input type="hidden" name="membershipId" value={member.membershipId} />
                    <Button type="submit" variant="ghost" size="sm">Clear override</Button>
                  </form>
                )}
                {member.acknowledgePending && (
                  <form action={acknowledgeAction} className="inline">
                    <input type="hidden" name="membershipId" value={member.membershipId} />
                    <ConfirmButton label="Acknowledge" confirmLabel="Mark availability as reviewed?" />
                  </form>
                )}
              </>
            ) : (
              <div className="flex flex-wrap gap-2">
                {sortedClinicDates.map((d) => {
                  const key = isoDateKey(d);
                  const checked = availKeys.has(key);
                  return (
                    <span
                      key={key}
                      className={`rounded-full border px-2.5 py-1 text-xs whitespace-nowrap ${checked ? "border-brand bg-brand/5 text-brand-fg font-semibold" : "border-border text-muted-foreground"}`}
                    >
                      {displayDate(key)}
                    </span>
                  );
                })}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
