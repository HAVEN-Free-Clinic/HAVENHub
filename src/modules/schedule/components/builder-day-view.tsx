import type { ReactNode } from "react";
import Link from "next/link";
import { Badge } from "@/platform/ui/badge";
import { PersonName } from "@/platform/ui/person-name";
import { Card } from "@/platform/ui/card";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Input } from "@/platform/ui/input";
import { AlertTriangle } from "lucide-react";
import { BuilderCell } from "./builder-cell";
import { IntakeNotes } from "./intake-notes";
import { isoDateKey } from "@/platform/dates";
import { rolesForDept } from "@/modules/schedule/engine/capacity";
import { compareBuilderMembers } from "@/modules/schedule/services/builder";
import type { builderView, BuilderAssignmentEntry } from "@/modules/schedule/services/builder";
import { SectionHeader } from "@/platform/ui/section-header";

// ---------------------------------------------------------------------------
// Day view -- Assigned / Available to assign columns
// ---------------------------------------------------------------------------

export type BuilderDayViewProps = {
  data: Awaited<ReturnType<typeof builderView>>;
  dept: { id: string; code: string; name: string };
  selectedDateKey: string | null;
  editable: boolean;
  /**
   * The people whose profile this viewer may open (see platform/member-profile).
   * Names in that set become links to their contact details and the reasons they
   * are or are not cleared; everyone else renders as plain text rather than as a
   * link that would bounce to /no-access.
   *
   * A plain Set, not a string[]: this is a server component rendering inside
   * another server component, so nothing crosses a serialization boundary.
   */
  profilePersonIds: Set<string>;
  assignAction: (fd: FormData) => Promise<void>;
  unassignAction: (fd: FormData) => Promise<void>;
  toggleTagAction: (fd: FormData) => Promise<void>;
};

export function BuilderDayView({
  data,
  dept,
  selectedDateKey,
  editable,
  profilePersonIds,
  assignAction,
  unassignAction,
  toggleTagAction,
}: BuilderDayViewProps) {
  const { members, assignmentsByDate, conflicts } = data;
  // Every builder user already sees clearance here: the not-cleared banner names
  // volunteers outright. So the badge is shown to the whole builder audience
  // rather than gated on volunteers.view the way passive surfaces are -- gating
  // it would hide from a director exactly what the banner above already tells
  // them, on the one screen where clearance changes a decision.
  const clearedIds = new Set(data.clearedPersonIds);

  const assignmentsOnDate: Record<string, BuilderAssignmentEntry> =
    selectedDateKey ? (assignmentsByDate[selectedDateKey] ?? {}) : {};

  const memberByPersonId = new Map(members.map((m) => [m.person.id, m]));

  // Resolve an assignee's display name and flag person, preferring the ACTIVE
  // member record but falling back to the identity carried on the assignment. An
  // assignee who lost their ACTIVE membership (offboarded) is absent from
  // `members`, so without this fallback the Day view printed their raw personId
  // cuid; now it shows their name and flags (audit M12).
  function assigneeInfo(pid: string): {
    name: string;
    flagPerson: { verifiedLanguages: string[]; licensedRN: boolean } | null;
  } {
    const member = memberByPersonId.get(pid);
    const entry = assignmentsOnDate[pid];
    return {
      name: member?.person.name ?? entry?.person.name ?? pid,
      flagPerson: member?.person ?? entry?.person ?? null,
    };
  }

  /**
   * Wraps a rendered name in a link to that person's profile, when the viewer
   * may open it. "Who is this and why are they not cleared" is the question a
   * director has standing in front of the roster, and until now the only way to
   * answer it was to leave the builder and search the compliance list.
   */
  function profileLink(personId: string, label: ReactNode): ReactNode {
    if (!profilePersonIds.has(personId)) return label;
    return (
      <Link href={`/volunteers/compliance/${personId}`} className="hover:underline">
        {label}
      </Link>
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

  // One badge per VERIFIED language, plus RN. The codes are short by design
  // (ES, HT, ZH) so a director scanning a dense grid reads capability at a
  // glance; the full label is in the language review queue.
  function flagBadges(person: { verifiedLanguages: string[]; licensedRN: boolean }) {
    if (person.verifiedLanguages.length === 0 && !person.licensedRN) return null;
    return (
      <>
        {person.verifiedLanguages.map((code) => (
          <Badge key={code} tone="default">{code.toUpperCase()}</Badge>
        ))}
        {person.licensedRN && <Badge tone="default">RN</Badge>}
      </>
    );
  }

  function assignCard(member: (typeof unassignedMembers)[number], available: boolean) {
    const isDirectorKind = member.kind === "DIRECTOR";
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
          {flagBadges(member.person)}
          {!available && <Badge tone="warning">not free</Badge>}
        </div>
        {editable && (
          <div className="flex flex-wrap gap-2">
            {isDirectorKind && (
              <BuilderCell
                action={assignAction}
                hidden={{
                  departmentId: dept.id,
                  dateKey: selectedDateKey ?? "",
                  personId: member.person.id,
                  role: "DIRECTOR",
                }}
                label="Assign as director"
                variant="assign"
              />
            )}
            <BuilderCell
              action={assignAction}
              hidden={{
                departmentId: dept.id,
                dateKey: selectedDateKey ?? "",
                personId: member.person.id,
                role: "VOLUNTEER",
              }}
              label="Assign as volunteer"
              variant="assign"
            />
            <BuilderCell
              action={assignAction}
              hidden={{
                departmentId: dept.id,
                dateKey: selectedDateKey ?? "",
                personId: member.person.id,
                role: "SHADOW",
              }}
              label="Assign as shadow"
              variant="assign"
            />
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

        {/* Clearance banner: volunteers scheduled here who are not fully cleared */}
        {data.banner.length > 0 && (
          <Card size="compact" pad={false} role="status" className="mb-4 px-4 py-3 text-sm text-foreground-soft">
            <p className="font-semibold mb-1 flex items-center gap-1.5 text-foreground">
              <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
              Clearance issues on this date
            </p>
            <ul className="list-disc list-inside space-y-0.5">
              {data.banner.flatMap((b) =>
                b.notCleared.map((v) => (
                  <li key={v.id}>{v.name}</li>
                ))
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
            <p className="text-sm text-subtle-foreground italic">None assigned</p>
          ) : (
            <div className="flex flex-col gap-2">
              {assignedDirectors.map((pid) => {
                const { name, flagPerson } = assigneeInfo(pid);
                // Directors carry the same per-assignment flags volunteers do:
                // a director can hold the triage post or work the day remotely,
                // and the full schedule surfaces those to the whole clinic. The
                // toggles were previously volunteer-only, so the flags existed
                // on the row but there was no way to set them for a director.
                const tags = assignmentsOnDate[pid]?.tags;
                return (
                  <Card key={pid} pad={false} className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {profileLink(pid, <span className="text-sm font-bold text-foreground">{name}</span>)}
                      {flagPerson && flagBadges(flagPerson)}
                    </div>
                    {editable && tags && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {([...rolesForDept(dept.code), "remote", "specialty"] as Array<"triage" | "walkin" | "cc" | "remote" | "specialty">).map((tag) => (
                          <BuilderCell
                            key={tag}
                            action={toggleTagAction}
                            hidden={{ departmentId: dept.id, dateKey: selectedDateKey ?? "", personId: pid, tag }}
                            label={tag === "walkin" ? "Walk-in" : tag.charAt(0).toUpperCase() + tag.slice(1)}
                            pressed={tags[tag]}
                            variant="tag"
                          />
                        ))}
                      </div>
                    )}
                    {editable && (
                      <form action={unassignAction} className="mt-2 flex items-center justify-end gap-2">
                        <input type="hidden" name="departmentId" value={dept.id} />
                        <input type="hidden" name="dateKey" value={selectedDateKey ?? ""} />
                        <input type="hidden" name="personId" value={pid} />
                        <ConfirmButton label="Remove" confirmLabel="Remove this director?" />
                      </form>
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
            Volunteers <span className="text-success">({assignedVolunteers.length})</span>
          </SectionHeader>
          {assignedVolunteers.length === 0 ? (
            <p className="text-sm text-subtle-foreground italic">None assigned</p>
          ) : (
            <div className="flex flex-col gap-2">
              {assignedVolunteers.map((pid) => {
                const { name, flagPerson } = assigneeInfo(pid);
                const assignment = assignmentsOnDate[pid]!;
                const tags = assignment.tags;
                const personConflicts = conflicts[pid] ?? [];
                return (
                  <Card key={pid} pad={false} className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      {profileLink(pid, <span className="font-medium text-foreground">{name}</span>)}
                      {flagPerson && flagBadges(flagPerson)}
                      {personConflicts.length > 0 && (
                        <Badge tone="warning" title={personConflicts.join(", ")}>
                          Also in {personConflicts.join(", ")}
                        </Badge>
                      )}
                    </div>
                    {editable && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {([...rolesForDept(dept.code), "remote", "specialty"] as Array<"triage" | "walkin" | "cc" | "remote" | "specialty">).map((tag) => (
                          <BuilderCell
                            key={tag}
                            action={toggleTagAction}
                            hidden={{ departmentId: dept.id, dateKey: selectedDateKey ?? "", personId: pid, tag }}
                            label={tag === "walkin" ? "Walk-in" : tag.charAt(0).toUpperCase() + tag.slice(1)}
                            pressed={tags[tag]}
                            variant="tag"
                          />
                        ))}
                      </div>
                    )}
                    {editable && (
                      <form action={unassignAction} className="mt-2 flex flex-wrap items-center gap-2">
                        <input type="hidden" name="departmentId" value={dept.id} />
                        <input type="hidden" name="dateKey" value={selectedDateKey ?? ""} />
                        <input type="hidden" name="personId" value={pid} />
                        <Input name="reason" aria-label="Removal reason" placeholder="Reason (optional)" className="flex-1 min-w-32" />
                        <ConfirmButton label="Remove" confirmLabel="Remove this volunteer?" />
                      </form>
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
            Shadows <span className="text-warning">({assignedShadows.length})</span>
          </SectionHeader>
          {assignedShadows.length === 0 ? (
            <p className="text-sm text-subtle-foreground italic">None assigned</p>
          ) : (
            <div className="flex flex-col gap-2">
              {assignedShadows.map((pid) => {
                const { name, flagPerson } = assigneeInfo(pid);
                return (
                  <Card key={pid} pad={false} className="px-3 py-2 flex items-center justify-between">
                    <span className="flex flex-wrap items-center gap-2">
                      {profileLink(pid, <span className="text-sm font-medium text-foreground-soft">{name}</span>)}
                      {flagPerson && flagBadges(flagPerson)}
                    </span>
                    {editable && (
                      <form action={unassignAction} className="flex items-center gap-2">
                        <input type="hidden" name="departmentId" value={dept.id} />
                        <input type="hidden" name="dateKey" value={selectedDateKey ?? ""} />
                        <input type="hidden" name="personId" value={pid} />
                        <ConfirmButton label="Remove" confirmLabel="Remove this shadow?" />
                      </form>
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
          <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-subtle-foreground">
            Select a date above to start assigning.
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-success mb-2">
                Available &middot; said yes ({availableMembers.length})
              </p>
              {availableMembers.length === 0 ? (
                <p className="text-sm text-subtle-foreground italic">No one is marked available for this date.</p>
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
