import Link from "next/link";
import type { Term } from "@prisma/client";
import { requirePersonSession } from "@/platform/auth/session";
import { redirect } from "next/navigation";
import { can } from "@/platform/rbac/engine";
import {
  canRecordAttendance,
  listEvents,
} from "@/modules/recruitment/services/attendance-events";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getNextTerm } from "@/platform/terms/next-term";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatDateTime } from "@/platform/dates";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { buttonClasses } from "@/platform/ui/button";
import { TextLink } from "@/platform/ui/text-link";
import { KIND_LABELS, kindTone } from "./kind-labels";

export function generateMetadata() {
  return buildPageMetadata({
    title: "Attendance events",
    description: "Take attendance at training sessions, info sessions and other events.",
  });
}

/** " in Summer 2026 and Fall 2026", or nothing at all when no term is live. */
function termsPhrase(term: Term | null, nextTerm: Term | null): string {
  const names = [term?.name, nextTerm?.name].filter((n): n is string => Boolean(n));
  if (names.length === 0) return "";
  return ` in ${names.join(" and ")}`;
}

export default async function EventsPage() {
  const viewer = await requirePersonSession();
  // Gate on the capability, not on recruitment.access: a door staffer may hold
  // recruitment.record_attendance and nothing else, and a department director is
  // admitted by review scope with no recruitment permission at all.
  if (!(await canRecordAttendance(viewer.personId))) redirect("/no-access");

  const [term, nextTerm, canManage, zone] = await Promise.all([
    getActiveTerm(),
    getNextTerm(),
    can(viewer.personId, "recruitment.manage_cycles"),
    getDisplayTimeZone(),
  ]);
  // The live term AND the one in preparation, not the live term alone.
  //
  // An event's term comes from its cycle, and a recruitment cycle recruits for
  // the term AFTER the one running: the Fall training session is created while
  // Summer is still ACTIVE. Filtering to the active term therefore hid every
  // event the clinic had, on the page whose whole job is to find the event you
  // are about to take attendance at.
  //
  // Still not an unfiltered list, which would be an archive rather than a
  // working surface: past terms' events stay reachable through their cycle.
  const termIds = [term?.id, nextTerm?.id].filter((id): id is string => Boolean(id));
  const events = await listEvents({ termIds });
  // Only worth naming the term per row when two of them are on screen at once.
  const showTermName = new Set(events.map((e) => e.termName)).size > 1;

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Attendance events"
        description={`Training sessions, info sessions and other events${termsPhrase(term, nextTerm)}.`}
        action={
          canManage ? (
            <Link href="/recruitment/events/new" className={buttonClasses("primary", "sm")}>
              New event
            </Link>
          ) : undefined
        }
      />

      <Table>
        <THead>
          <tr>
            <TH>Event</TH>
            <TH>When</TH>
            <TH>Cycle</TH>
            <TH className="text-right">Checked in</TH>
            <TH className="text-right">Actions</TH>
          </tr>
        </THead>
        <tbody>
          {events.map((event) => (
            <TR key={event.id}>
              <TD className="font-medium text-foreground">
                <Link href={`/recruitment/events/${event.id}`} className="hover:underline">
                  {event.title}
                </Link>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Badge tone={kindTone(event.kind)}>{KIND_LABELS[event.kind]}</Badge>
                  {/* Only when two terms are on screen: with the list scoped to
                      the live term and the one in preparation, a Fall training
                      session and a Summer one can sit a row apart, and taking
                      attendance at the wrong one credits the wrong term. */}
                  {showTermName && <Badge>{event.termName}</Badge>}
                </div>
              </TD>
              <TD className="text-foreground-soft">
                {formatDateTime(event.startsAt, zone)}
                {event.location && (
                  <div className="text-xs text-subtle-foreground">{event.location}</div>
                )}
              </TD>
              <TD className="text-foreground-soft">{event.cycleTitle ?? "-"}</TD>
              <TD className="text-right text-foreground-soft">
                {event.attendeeCount}
                {event.unlinkedCount > 0 && (
                  <div className="text-xs text-subtle-foreground">
                    {event.unlinkedCount} not linked
                  </div>
                )}
              </TD>
              <TD className="text-right">
                <TextLink
                  href={`/check-in/${event.id}`}
                  size="sm"
                  className="font-medium"
                >
                  Check in
                </TextLink>
              </TD>
            </TR>
          ))}
          {events.length === 0 && (
            <TR>
              <TD colSpan={5} className="py-10 text-center text-subtle-foreground">
                No events yet.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
    </div>
  );
}
