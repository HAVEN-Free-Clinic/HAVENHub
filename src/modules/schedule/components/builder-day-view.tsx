"use client";

/**
 * Day view -- Assigned / Available to assign, for one clinic date.
 *
 * A client component since the builder became interactive. Every assign, role
 * change, tag toggle and removal writes through {@link useBuilderBoard}: applied
 * to the board at once, POSTed, reconciled. It used to post a form per button and
 * redirect back to this same URL, which re-ran the whole page load and scrolled
 * the page back to the top -- from the bottom of a fifty-person pool, on every
 * single click.
 *
 * Props are narrowed to exactly what this view reads rather than the whole
 * builderView: everything here crosses the RSC boundary now, so the page pays for
 * each field it hands over.
 */

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { PersonName } from "@/platform/ui/person-name";
import { Card } from "@/platform/ui/card";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Input } from "@/platform/ui/input";
import { AlertTriangle } from "lucide-react";
import { IntakeNotes } from "./intake-notes";
import {
  PROVISIONAL_BADGE_LABEL,
  PROVISIONAL_STAGE_LABEL,
  provisionalBlockedReason,
} from "./provisional-labels";
import { isoDateKey } from "@/platform/dates";
import { rolesForDept } from "@/modules/schedule/engine/capacity";
import { compareBuilderMembers } from "@/modules/schedule/engine/member-order";
import type { BuilderMember, ShiftTag } from "@/modules/schedule/services/builder";
import { useBuilderBoard, type BoardApi } from "./builder-board";
import { SectionHeader } from "@/platform/ui/section-header";
import { EmptyState } from "@/platform/ui/empty-state";
import { CapabilityBadges } from "@/platform/ui/capability-badges";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type BuilderDayViewProps = {
  members: BuilderMember[];
  /** Map: personId -> other-department names this person also works that day. */
  conflicts: Record<string, string[]>;
  /** Not-cleared volunteers scheduled on this date, for the clearance banner. */
  banner: { notCleared: { id: string; name: string }[] }[];
  /** Members fully cleared for this date, for the verified badge. */
  clearedPersonIds: string[];
  /** `minInterpreterScore` is what the Spanish badge is measured against: a
   *  speaker below THIS department's bar is marked, one at or above it is not. */
  dept: { id: string; code: string; name: string; minInterpreterScore: number | null };
  selectedDateKey: string | null;
  /**
   * The people whose profile this viewer may open (see platform/member-profile).
   * Names in that set become links to their contact details and the reasons they
   * are or are not cleared; everyone else renders as plain text rather than as a
   * link that would bounce to /no-access.
   *
   * A plain array, not a Set: this component is a client component now, and a Set
   * does not survive the RSC boundary.
   */
  profilePersonIds: string[];
  /** Test seam: a stub board in place of the surrounding provider's. */
  board?: BoardApi;
};

/** The tag toggles offered for a department, in a stable order. */
function tagsForDept(deptCode: string): ShiftTag[] {
  return [...rolesForDept(deptCode), "remote", "specialty"] as ShiftTag[];
}

function tagLabel(tag: ShiftTag): string {
  return tag === "walkin" ? "Walk-in" : tag.charAt(0).toUpperCase() + tag.slice(1);
}

// ---------------------------------------------------------------------------
// Removal with an optional reason
// ---------------------------------------------------------------------------

/**
 * Remove a volunteer, optionally saying why. The reason is captured into the
 * audit trail by setAssignment; it is held here rather than in the board because
 * it belongs to one click, not to the schedule.
 */
function RemoveWithReason({
  onRemove,
  busy,
}: {
  onRemove: (reason: string) => void;
  busy: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Input
        name="reason"
        aria-label="Removal reason"
        placeholder="Reason (optional)"
        className="flex-1 min-w-32"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <ConfirmButton
        label="Remove"
        confirmLabel="Remove this volunteer?"
        busy={busy}
        onConfirm={() => onRemove(reason.trim())}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day view
// ---------------------------------------------------------------------------

export function BuilderDayView({
  members,
  conflicts,
  banner,
  clearedPersonIds,
  dept,
  selectedDateKey,
  profilePersonIds,
  board: boardOverride,
}: BuilderDayViewProps) {
  const board = useBuilderBoard(boardOverride);
  const editable = board.editable;
  const dateKey = selectedDateKey ?? "";

  // Every builder user already sees clearance here: the not-cleared banner names
  // volunteers outright. So the badge is shown to the whole builder audience
  // rather than gated on volunteers.view the way passive surfaces are -- gating
  // it would hide from a director exactly what the banner above already tells
  // them, on the one screen where clearance changes a decision.
  const clearedIds = new Set(clearedPersonIds);
  const profileIds = new Set(profilePersonIds);

  const assignmentsOnDate = selectedDateKey
    ? (board.assignments[selectedDateKey] ?? {})
    : {};

  const memberByPersonId = new Map(members.map((m) => [m.person.id, m]));

  // Resolve an assignee's display name and flag person, preferring the ACTIVE
  // member record but falling back to the identity carried on the assignment. An
  // assignee who lost their ACTIVE membership (offboarded) is absent from
  // `members`, so without this fallback the Day view printed their raw personId
  // cuid; now it shows their name and flags (audit M12).
  function assigneeInfo(pid: string): {
    name: string;
    flagPerson: { verifiedLanguages: string[]; spanishScore: number | null; licensedRN: boolean } | null;
  } {
    const member = memberByPersonId.get(pid);
    const entry = assignmentsOnDate[pid];
    return {
      name: member?.person.name ?? entry?.person.name ?? pid,
      flagPerson: member?.person ?? entry?.person ?? null,
    };
  }

  /**
   * The "Incoming" chip for an assignee who is accepted but not on the roster
   * yet, or null for everyone else.
   *
   * Shown in the Assigned column as well as the pool, because "who is working
   * this Saturday" is the question this column answers, and a draft shift on
   * somebody still finishing onboarding is a different answer from a confirmed
   * one. Without it the two are indistinguishable once assigned.
   */
  function incomingBadge(pid: string): ReactNode {
    const incoming = memberByPersonId.get(pid)?.provisional;
    if (!incoming) return null;
    return (
      <Badge tone="warning" title={PROVISIONAL_STAGE_LABEL[incoming.stage]}>
        {PROVISIONAL_BADGE_LABEL}
      </Badge>
    );
  }

  /**
   * Wraps a rendered name in a link to that person's profile, when the viewer
   * may open it. "Who is this and why are they not cleared" is the question a
   * director has standing in front of the roster, and until now the only way to
   * answer it was to leave the builder and search the compliance list.
   */
  function profileLink(personId: string, label: ReactNode): ReactNode {
    if (!profileIds.has(personId)) return label;
    return (
      <Link href={`/volunteers/compliance/${personId}`} className="hover:underline">
        {label}
      </Link>
    );
  }

  /** The tag toggle row shared by the director and volunteer cards. */
  function tagToggles(pid: string): ReactNode {
    const tags = assignmentsOnDate[pid]?.tags;
    if (!tags) return null;
    const busy = board.isBusy(dateKey, pid);
    return (
      <div className="mt-2 flex flex-wrap gap-1">
        {tagsForDept(dept.code).map((tag) => (
          <Button
            key={tag}
            type="button"
            variant={tags[tag] ? "primary" : "outline"}
            size="sm"
            className="text-xs px-2 py-0.5"
            aria-pressed={tags[tag]}
            disabled={busy}
            onClick={() => board.toggleTag(dateKey, pid, tag)}
          >
            {tagLabel(tag)}
          </Button>
        ))}
      </div>
    );
  }

  const assignedDirectors = Object.entries(assignmentsOnDate)
    .filter(([, a]) => a.role === "DIRECTOR")
    .map(([pid]) => pid);

  const assignedVolunteers = Object.entries(assignmentsOnDate)
    .filter(([, a]) => a.role === "VOLUNTEER")
    .map(([pid]) => pid);

  const assignedShadows = Object.entries(assignmentsOnDate)
    .filter(([, a]) => a.role === "SHADOW")
    .map(([pid]) => pid);

  const assignedPersonIds = new Set(Object.keys(assignmentsOnDate));

  const unassignedMembers = selectedDateKey
    ? members.filter((m) => !assignedPersonIds.has(m.person.id))
    : members;

  const isAvailableOnDate = (m: (typeof unassignedMembers)[number]) =>
    selectedDateKey
      ? m.availability.dates.some((d) => isoDateKey(d) === selectedDateKey)
      : false;

  // Directors first, then volunteers, alphabetical within each group.
  const availableMembers = unassignedMembers
    .filter(isAvailableOnDate)
    .sort(compareBuilderMembers);
  const notAvailableMembers = unassignedMembers
    .filter((m) => !isAvailableOnDate(m))
    .sort(compareBuilderMembers);
  const availableCount = availableMembers.length;

  // The SAME badges the read-only Full Schedule renders, not a second set.
  //
  // This used to hand-roll `<Badge tone="default">ES</Badge>`: no score, no
  // below-bar mark, and no accessible name at all -- the whole meaning of a
  // two-letter code available to nobody using a screen reader. So one
  // interpreter read "ES 2" in warning tone on /schedule/full and a plain "ES"
  // here, on the one screen where somebody actually assigns them to a patient.
  //
  // The `verifiedLanguages.length === 0 && !licensedRN` early return is dropped
  // because CapabilityBadges already renders nothing in that case.
  function flagBadges(person: {
    verifiedLanguages: string[];
    spanishScore: number | null;
    licensedRN: boolean;
  }) {
    return <CapabilityBadges person={person} department={dept} />;
  }

  function assignCard(member: (typeof unassignedMembers)[number], available: boolean) {
    const isDirectorKind = member.kind === "DIRECTOR";
    const incoming = member.provisional;
    const blockedReason = incoming ? provisionalBlockedReason(incoming) : null;
    // An incoming applicant with no Hub account has no person for a shift to
    // point at, so the card names them and their availability but offers no
    // buttons. Everyone else incoming is assignable exactly like a member: the
    // shift is real, and simply stays inert until roster build gives them the
    // membership every outbound path filters on.
    const canAssign = editable && blockedReason === null && selectedDateKey !== null;
    const busy = board.isBusy(dateKey, member.person.id);
    return (
      <Card
        key={member.person.id}
        pad={false}
        className={`px-3 py-3${available ? "" : " opacity-75"}`}
      >
        <div className="flex flex-wrap items-center gap-2 mb-2">
          {profileLink(
            member.person.id,
            <PersonName name={member.person.name} cleared={clearedIds.has(member.person.id)} className="text-sm font-semibold text-foreground" />,
          )}
          <Badge tone={isDirectorKind ? "brand" : "default"}>
            {isDirectorKind ? "Director" : "Volunteer"}
          </Badge>
          {incoming && (
            <>
              <Badge tone="warning">{PROVISIONAL_BADGE_LABEL}</Badge>
              <Badge tone="default">{PROVISIONAL_STAGE_LABEL[incoming.stage]}</Badge>
            </>
          )}
          {flagBadges(member.person)}
          {!available && <Badge tone="warning">not free</Badge>}
        </div>
        {blockedReason && (
          <p className="mb-2 text-xs text-subtle-foreground">{blockedReason}</p>
        )}
        {canAssign && (
          <div className="flex flex-wrap gap-2">
            {isDirectorKind && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => board.assign(dateKey, member.person.id, "DIRECTOR")}
              >
                Assign as director
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => board.assign(dateKey, member.person.id, "VOLUNTEER")}
            >
              Assign as volunteer
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => board.assign(dateKey, member.person.id, "SHADOW")}
            >
              Assign as shadow
            </Button>
          </div>
        )}
        <IntakeNotes intake={member.intake} />
      </Card>
    );
  }

  return (
    <>
      {/* Column 1: Assigned */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <SectionHeader as="h2" level="title">Assigned</SectionHeader>
          <Badge tone="success">
            {assignedDirectors.length + assignedVolunteers.length + assignedShadows.length} assigned
          </Badge>
        </div>

        {/* Clearance banner: volunteers scheduled here who are not fully cleared.
            Server-computed, so it trails the board by one background refresh
            after a change made here; the names on it are still the names it
            named, never a stale claim about someone who has been removed. */}
        {banner.length > 0 && (
          <Card size="compact" pad={false} role="status" className="mb-4 px-4 py-3 text-sm text-foreground-soft">
            <p className="font-semibold mb-1 flex items-center gap-1.5 text-foreground">
              <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
              Clearance issues on this date
            </p>
            <ul className="list-disc list-inside space-y-0.5">
              {banner.flatMap((b) =>
                b.notCleared
                  .filter((v) => assignedPersonIds.has(v.id))
                  .map((v) => <li key={v.id}>{v.name}</li>),
              )}
            </ul>
          </Card>
        )}

        {/* Directors */}
        <div className="mb-5">
          <SectionHeader as="h3" className="mb-2">
            Directors <span className="text-brand-fg">({assignedDirectors.length})</span>
          </SectionHeader>
          {assignedDirectors.length === 0 ? (
            <EmptyState inline className="italic">None assigned</EmptyState>
          ) : (
            <div className="flex flex-col gap-2">
              {assignedDirectors.map((pid) => {
                const { name, flagPerson } = assigneeInfo(pid);
                return (
                  <Card key={pid} pad={false} className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {profileLink(pid, <span className="text-sm font-bold text-foreground">{name}</span>)}
                      {flagPerson && flagBadges(flagPerson)}
                      {incomingBadge(pid)}
                    </div>
                    {/* Directors carry the same per-assignment flags volunteers
                        do: a director can hold the triage post or work the day
                        remotely, and the full schedule surfaces those to the
                        whole clinic. */}
                    {editable && tagToggles(pid)}
                    {editable && (
                      <div className="mt-2 flex items-center justify-end gap-2">
                        <ConfirmButton
                          label="Remove"
                          confirmLabel="Remove this director?"
                          busy={board.isBusy(dateKey, pid)}
                          onConfirm={() => board.unassign(dateKey, pid)}
                        />
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {/* Volunteers */}
        <div className="mb-5">
          <SectionHeader as="h3" className="mb-2">
            Volunteers <span className="text-success-foreground">({assignedVolunteers.length})</span>
          </SectionHeader>
          {assignedVolunteers.length === 0 ? (
            <EmptyState inline className="italic">None assigned</EmptyState>
          ) : (
            <div className="flex flex-col gap-2">
              {assignedVolunteers.map((pid) => {
                const { name, flagPerson } = assigneeInfo(pid);
                const personConflicts = conflicts[pid] ?? [];
                return (
                  <Card key={pid} pad={false} className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      {profileLink(pid, <span className="font-medium text-foreground">{name}</span>)}
                      {flagPerson && flagBadges(flagPerson)}
                      {incomingBadge(pid)}
                      {personConflicts.length > 0 && (
                        <Badge tone="warning" title={personConflicts.join(", ")}>
                          Also in {personConflicts.join(", ")}
                        </Badge>
                      )}
                    </div>
                    {editable && tagToggles(pid)}
                    {editable && (
                      <RemoveWithReason
                        busy={board.isBusy(dateKey, pid)}
                        onRemove={(reason) => board.unassign(dateKey, pid, reason || undefined)}
                      />
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {/* Shadows */}
        <div>
          <SectionHeader as="h3" className="mb-2">
            Shadows <span className="text-warning-foreground">({assignedShadows.length})</span>
          </SectionHeader>
          {assignedShadows.length === 0 ? (
            <EmptyState inline className="italic">None assigned</EmptyState>
          ) : (
            <div className="flex flex-col gap-2">
              {assignedShadows.map((pid) => {
                const { name, flagPerson } = assigneeInfo(pid);
                return (
                  <Card key={pid} pad={false} className="px-3 py-2 flex items-center justify-between">
                    <span className="flex flex-wrap items-center gap-2">
                      {profileLink(pid, <span className="text-sm font-medium text-foreground-soft">{name}</span>)}
                      {flagPerson && flagBadges(flagPerson)}
                      {incomingBadge(pid)}
                    </span>
                    {editable && (
                      <ConfirmButton
                        label="Remove"
                        confirmLabel="Remove this shadow?"
                        busy={board.isBusy(dateKey, pid)}
                        onConfirm={() => board.unassign(dateKey, pid)}
                      />
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Column 2: Available to assign */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <SectionHeader as="h2" level="title">Available to assign</SectionHeader>
          <Badge tone="success">{availableCount} available</Badge>
        </div>

        {!selectedDateKey ? (
          <EmptyState bordered title="Select a date above to start assigning" />
        ) : (
          <div className="flex flex-col gap-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-success-foreground mb-2">
                Available &middot; said yes ({availableMembers.length})
              </p>
              {availableMembers.length === 0 ? (
                <EmptyState inline className="italic">No one is marked available for this date.</EmptyState>
              ) : (
                <div className="flex flex-col gap-2">
                  {availableMembers.map((m) => assignCard(m, true))}
                </div>
              )}
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-subtle-foreground mb-2">
                Not available ({notAvailableMembers.length})
              </p>
              {notAvailableMembers.length === 0 ? (
                <p className="text-sm text-subtle-foreground italic">Everyone else is already assigned.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {notAvailableMembers.map((m) => assignCard(m, false))}
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
