import { Suspense, type CSSProperties } from "react";
import Link from "next/link";
import {
  CalendarDays,
  ClipboardList,
  Stethoscope,
  ArrowRight,
  Repeat,
  Check,
  Clock,
  ChevronRight,
  ClipboardCheck,
  UserRound,
} from "lucide-react";
import { requirePersonSession } from "@/platform/auth/session";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { MODULES } from "@/platform/modules/registry";
import { canAccessModule } from "@/platform/modules/access";
import type { ModuleManifest } from "@/platform/modules/types";
import { TimeGreeting } from "@/platform/ui/time-greeting";
import { Card, cardClasses } from "@/platform/ui/card";
import { ClinicChannelCard } from "./clinic-channel-card";
import { EpicAccessCard } from "./epic-access-card";
import { mySchedule } from "@/modules/schedule/services/schedule";
import { myAttendingSchedule } from "@/modules/schedule/services/attending-portal";
import { countPendingApprovals } from "@/modules/schedule/services/requests";
import { getCheckInState } from "@/modules/schedule/services/attendance";
import { buildActionCards, type ActionCard } from "./action-cards";
import { listMyCertificates } from "@/modules/my-info/services/my-info";
import { getOnboardingStatus, getMyOnboarding, type OnboardingTask } from "@/modules/onboarding/services/onboarding";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getMyTraining } from "@/modules/recruitment/services/training";
import { isInterviewPanelist } from "@/modules/recruitment/services/interviews";
import { reviewScope } from "@/modules/recruitment/services/review";
import { effectiveCompliance, certExpiresAt } from "@/platform/compliance/rules";
import { getSetting } from "@/platform/settings/service";
import { isoDateKey, formatCalendarDate, formatForDateInput, formatTimeOnly } from "@/platform/dates";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { buildPageMetadata } from "@/platform/branding/metadata";

// ---------------------------------------------------------------------------
// Presentation helpers (pure)
// ---------------------------------------------------------------------------

/** Per-module accent hue key; drives the colored icon tile + left swatch. */
const HUE_BY_MODULE: Record<string, string> = {
  schedule: "schedule",
  "my-info": "info",
  volunteers: "volunteers",
  recruitment: "recruit",
  "my-interviews": "recruit",
  admin: "admin",
};

/** CSS vars for a given hue token key, so Tailwind's static scan never sees dynamic hues. */
function hueVars(hue: string): CSSProperties {
  return {
    ["--mh" as string]: `var(--mod-${hue})`,
    ["--mhbg" as string]: `var(--mod-${hue}-bg)`,
  } as CSSProperties;
}

/** Module-tile hue, keyed by module id. */
function hueStyle(id: string): CSSProperties {
  return hueVars(HUE_BY_MODULE[id] ?? "schedule");
}

function timeGreeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/** "Saturday, June 13" (clinic dates are stored at noon UTC, so format in UTC). */
function fmtLongDate(d: Date): string {
  return formatCalendarDate(d, { weekday: "long", month: "long", day: "numeric" });
}

/** "Aug 2026" */
function fmtMonthYear(d: Date): string {
  return formatCalendarDate(d, { month: "short", year: "numeric" });
}

/** Whole calendar days between two YYYY-MM-DD keys. */
function daysBetweenKeys(fromKey: string, toKey: string): number {
  const a = Date.parse(`${fromKey}T00:00:00Z`);
  const b = Date.parse(`${toKey}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

function roleLabel(role: string): string {
  if (role === "DIRECTOR") return "Shift director";
  if (role === "SHADOW") return "Shadowing";
  return "Volunteer";
}

function shiftTags(tags: { triage: boolean; walkin: boolean; cc: boolean; remote: boolean }): string[] {
  const out: string[] = [];
  if (tags.triage) out.push("Triage");
  if (tags.walkin) out.push("Walk-in");
  if (tags.cc) out.push("CC");
  if (tags.remote) out.push("Remote");
  return out;
}

/**
 * One "Your status" row from a semester-clearance task. Mirrors My Info's
 * Clearance card: same labels and satisfied/not-satisfied split. HIPAA keeps the
 * dashboard's richer expiry-aware sub (passed in); other tasks use short status
 * text. Links point at the real module page, not the /get-started gate, so they
 * are valid whether or not the person is already cleared.
 */
function clearanceRow(
  task: OnboardingTask,
  hipaaSub: string
): { ok: boolean; title: string; sub: string; href: string } {
  const href =
    task.key === "training" || task.key === "directorTraining"
      ? "/training"
      : task.key === "learning"
        ? "/learning"
        : "/my-info"; // profile, hipaa, ehs
  const sub =
    task.key === "hipaa"
      ? hipaaSub
      : task.state === "COMPLETE"
        ? "Complete"
        : task.state === "IN_PROGRESS"
          ? "In progress"
          : "Not started"; // INCOMPLETE
  return { ok: task.state === "COMPLETE", title: task.label, sub, href };
}

// ---------------------------------------------------------------------------
// Module tile
// ---------------------------------------------------------------------------

function ModuleTile({ m }: { m: ModuleManifest }) {
  const Icon = m.icon;

  return (
    <Link
      href={`/${m.id}`}
      aria-label={`Open ${m.title}`}
      style={hueStyle(m.id)}
      className={cardClasses({ interactive: true, pad: false }) + " group relative flex items-start gap-4 overflow-hidden p-[18px]"}
    >
      <span
        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl"
        style={{ color: "var(--mh)", background: "var(--mhbg)" }}
      >
        <Icon aria-hidden className="h-[22px] w-[22px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-bold text-foreground">{m.title}</span>
        <span className="mt-1 block text-[13px] leading-relaxed text-muted-foreground">{m.description}</span>
      </span>
      <ArrowRight
        aria-hidden
        className="mt-0.5 h-[18px] w-[18px] shrink-0 self-center text-subtle-foreground transition group-hover:translate-x-0.5 group-hover:text-muted-foreground"
      />
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function generateMetadata() {
  return buildPageMetadata({ title: "Dashboard" });
}

/**
 * The hub lives at the root: the deployed domain is hub.havenfreeclinic.org,
 * so "/" is the landing page for signed-in members. Unauthenticated visitors
 * are redirected to /login by requirePersonSession.
 *
 * The home is a personalized dashboard: a greeting, the member's next shift,
 * a ranked action feed, color-coded module tiles, and a side rail with this
 * week's clinic channel and their real compliance status.
 */
export default async function HubPage() {
  const person = await requirePersonSession();
  // One permission fetch per render; tiles filter in memory (never can() in a loop).
  const permissions = await getEffectivePermissions(person.personId);

  const [schedule, certificates, isPanelist, orgName, onboarding, myOnboarding, myTraining, pendingApprovals, recruitmentScope, displayZone, liveTerm, checkIn, attendingSchedule] = await Promise.all([
    mySchedule(person.personId),
    listMyCertificates(person.personId),
    isInterviewPanelist(person.personId),
    getSetting<string>("branding.orgName"),
    getOnboardingStatus(person.personId),
    getMyOnboarding(person.personId),
    getMyTraining(person.personId),
    countPendingApprovals(person.personId),
    reviewScope(person.personId),
    getDisplayTimeZone(),
    getActiveTerm(),
    getCheckInState(person.personId),
    // Null for everyone who is not faculty, which is almost everyone.
    myAttendingSchedule(person.personId),
  ]);
  // The dashboard is a live-term view only: next-term shifts/requests are not
  // shown here (they belong to the term-aware schedule page). See mySchedule.
  const liveEntry = schedule.terms.find((t) => t.isLive) ?? null;
  // Membership-independent: mirrors getOnboardingStatus's own term resolution
  // (getActiveTerm), so the compliance sub-text below always agrees with the
  // clearance checkmark, even for a person with no active live-term membership.
  const term = liveTerm;
  const shifts = liveEntry?.shifts ?? [];

  // --- Module visibility ---
  // A department director reviews recruitment applications by scope (not a
  // recruitment permission), so surface the recruitment tile for them too --
  // matching the sub-nav, which the recruitment layout also renders by scope.
  const isRecruitmentReviewer = recruitmentScope.all || recruitmentScope.departmentCodes.length > 0;
  const activeModules = MODULES.filter(
    (m) =>
      m.status === "active" &&
      (canAccessModule(m, permissions) || (m.id === "recruitment" && isRecruitmentReviewer))
  );
  const accessible = new Set(activeModules.map((m) => m.id));

  // --- Next shift ---
  // "Today" must be the display-zone (ET) calendar day, not UTC: clinic dates are
  // stored at noon UTC (so isoDateKey gives their intended calendar day), but a raw
  // isoDateKey(new Date()) rolls over at UTC midnight (~8pm ET), which would label
  // tomorrow's shift "Today" and drop a same-day shift every evening.
  const todayKey = formatForDateInput(new Date(), displayZone);
  const upcoming = shifts.filter((s) => isoDateKey(s.clinicDate) >= todayKey);

  // The hero shows the next COMMITMENT, which for faculty is an attending column
  // rather than a volunteer shift. Normalised to one shape because the two are
  // different records (ShiftAssignment vs ClinicDayAttending) with no common
  // supertype, and the hero needs exactly four things from either: the date, what
  // to call it, the role line, and any extra detail.
  //
  // Without this an attending saw "No upcoming shifts -- you have no shifts
  // scheduled for the rest of <term>" on the Saturday they were covering, which is
  // not merely empty but false.
  type NextCommitment = {
    clinicDate: Date;
    /** The line under the date: a department name, or the schedule column. */
    where: string;
    /** The role line: "Volunteer", "Director", or "Attending". */
    role: string;
    /** Tags for a volunteer shift; who they cover with for an attending date. */
    detail: string[];
    /** The attending covering a volunteer's own department that day. */
    attendings: string[];
  };

  const volunteerNext: NextCommitment | null = upcoming[0]
    ? {
        clinicDate: upcoming[0].clinicDate,
        where: upcoming[0].department.name,
        role: roleLabel(upcoming[0].role),
        detail: shiftTags(upcoming[0].tags),
        attendings: upcoming[0].attendings.map((a) => a.name),
      }
    : null;

  // Closed Saturdays are excluded: the clinic is not running, so it is not a
  // commitment. Every attending-facing reader honours that flag.
  const attendingUpcoming = (attendingSchedule?.shifts ?? []).filter(
    (s) => !s.isClosed && isoDateKey(s.clinicDate) >= todayKey,
  );
  const attendingNext: NextCommitment | null = attendingUpcoming[0]
    ? {
        clinicDate: attendingUpcoming[0].clinicDate,
        where: `${attendingUpcoming[0].slot.label} · ${attendingUpcoming[0].slot.startTime}-${attendingUpcoming[0].slot.endTime}`,
        role: "Attending",
        detail:
          attendingUpcoming[0].alongside.length > 0
            ? [`With ${attendingUpcoming[0].alongside.join(", ")}`]
            : [],
        attendings: [],
      }
    : null;

  // Whichever comes first for someone who is both. Ties go to the volunteer shift,
  // which carries the check-in the hero's banner pairs with.
  const next: NextCommitment | null =
    volunteerNext && attendingNext
      ? isoDateKey(attendingNext.clinicDate) < isoDateKey(volunteerNext.clinicDate)
        ? attendingNext
        : volunteerNext
      : (volunteerNext ?? attendingNext);

  const daysAway = next ? daysBetweenKeys(todayKey, isoDateKey(next.clinicDate)) : 0;
  const nextTags = next ? next.detail : [];

  // --- Greeting context ---
  const firstName = person.name ? person.name.trim().split(/\s+/)[0] : null;
  // The greeting eyebrow wants an ORGANISATIONAL home, so it reads the volunteer
  // department directly rather than `next.where` -- which for an attending is a
  // schedule column ("9am-12pm"), a time of day and not a place to belong to.
  // Faculty fall back to their specialty, and to the term alone if they have none.
  const dept =
    upcoming[0]?.department.name ??
    shifts[0]?.department.name ??
    attendingSchedule?.attending.specialty?.name ??
    null;
  const eyebrow = [term?.name ?? attendingSchedule?.term?.name, dept].filter(Boolean).join(" · ") || orgName;

  // --- Compliance status (real data, same rules as My Info) ---
  // effectiveCompliance over the WHOLE history, not complianceStatus(certificates[0]).
  // Mid-renewal the newest cert is an unverified upload while the member is still
  // covered by an older verified one, and the card read the two halves from
  // different rules: the task's checkmark came from the full history (cleared),
  // the sub-text from the newest cert alone ("Awaiting verification"), so the card
  // contradicted itself on exactly the members doing the right thing early
  // (audit 14, L2).
  const status = effectiveCompliance(certificates, term?.endDate ?? null).status;

  // HIPAA sub copy, expiry aware, computed PER TERM: the rules are term-sensitive
  // (COMPLIANT requires expiresAt >= termEnd + 30d), so a cert that clears the
  // live term but not a next term must read "Renew before ..." under that term's
  // heading, not reuse the live term's "Valid through ..." (#87).
  //
  // The expiry is resolved inside the closure rather than hoisted, because WHICH
  // cert is the effective one is itself term-dependent: the fallback only accepts
  // an older cert that is COMPLIANT or EXPIRING_SOON *for that term*. Hoisting it
  // would print one term's expiry under another term's heading.
  const hipaaSubForTerm = (termEnd: Date | null): string => {
    const { status: s, cert } = effectiveCompliance(certificates, termEnd);
    const expiry =
      cert?.completionDate != null ? fmtMonthYear(certExpiresAt(cert.completionDate)) : null;
    return s === "COMPLIANT"
      ? (expiry ? `Valid through ${expiry}` : "On file")
      : s === "EXPIRING_SOON"
        ? (expiry ? `Renew before ${expiry}` : "Renew soon")
        : s === "EXPIRED"
          ? "Upload a current certificate"
          : s === "UNKNOWN_DATE"
            ? "Completion date pending review"
            : s === "PENDING_VERIFICATION"
              ? "Awaiting verification"
              : "Required for clinic clearance"; // NO_CERTIFICATE
  };
  // The live-term sub copy, reused for the live-term and no-term fallbacks below.
  const hipaaSub = hipaaSubForTerm(term?.endDate ?? null);

  // One clearance group per term the member belongs to (ACTIVE TermMembership).
  // Two fallbacks for viewers with no such membership: if a live term exists,
  // mirror the old single-group live-term checklist (getOnboardingStatus already
  // computes profile/HIPAA/learning/EHS off the live term regardless of
  // membership); otherwise fall back to a bare HIPAA line with no pill.
  // An attending is not onboarding onto the volunteer roster, so the middle
  // fallback below must not fire for them. getOnboardingStatus computes
  // profile/HIPAA off the live term REGARDLESS of membership (neither task
  // consults it), so faculty were shown "Not yet cleared" with an orange HIPAA
  // row pointing at /my-info -- for a clearance they hold no shift under and a
  // certificate Faculty Relations tracks on AttendingCredentialing instead. That
  // also contradicted enforceOnboarding, which no longer gates them at all: the
  // card nagged about something nothing enforces.
  //
  // Narrowed to linked attendings rather than to everyone with no membership.
  // Alumni and staff-only accounts land in the same fallback, but for them the
  // checklist is merely stale rather than addressed to the wrong process, and
  // widening this is a behaviour change on a surface outside this feature.
  const isFaculty = attendingSchedule !== null;
  const statusGroups = myOnboarding.length > 0
    ? myOnboarding.map((entry) => ({
        termId: entry.term.id,
        termName: entry.term.name,
        cleared: entry.status.cleared,
        hasTasks: entry.status.tasks.filter((t) => t.state !== "NOT_REQUIRED").length > 0,
        // Per-term HIPAA copy: use this entry's own term end so a next-term cert gap
        // shows "Renew before ..." on the exact term it applies to (#87).
        lines: entry.status.tasks.filter((t) => t.state !== "NOT_REQUIRED").map((t) => clearanceRow(t, hipaaSubForTerm(entry.term.endDate))),
      }))
    : onboarding.hasActiveTerm && !isFaculty
      ? [{
          termId: "live",
          termName: "",
          cleared: onboarding.cleared,
          hasTasks: onboarding.tasks.filter((t) => t.state !== "NOT_REQUIRED").length > 0,
          lines: onboarding.tasks.filter((t) => t.state !== "NOT_REQUIRED").map((t) => clearanceRow(t, hipaaSub)),
        }]
      : isFaculty
        ? // Nothing to report, so report nothing. A bare "HIPAA certificate --
          // required for clinic clearance" row is the same wrong claim in a
          // shorter form: an attending's clinic credentials are Faculty
          // Relations' to track, and the card would sit permanently orange over
          // a task they cannot action. The section is dropped instead (see the
          // statusGroups.length guard on the render).
          []
        : [{
            termId: "none",
            termName: "",
            cleared: status === "COMPLIANT" || status === "EXPIRING_SOON",
            hasTasks: false,
            lines: [{ ok: status === "COMPLIANT" || status === "EXPIRING_SOON", title: "HIPAA certificate", sub: hipaaSub, href: "/my-info" }],
          }];

  // --- Smart action feed: personal + role actions ranked by urgency, module
  // shortcuts backfilling any remaining slots (see action-cards.ts). ---
  // Open trainings across every term the member belongs to (each needs a designated cycle).
  const openTrainings = myTraining.filter((m) => m.cycle && m.state !== "COMPLETE");
  const learningTask = onboarding.tasks.find(
    (t) => t.key === "learning" && t.state !== "COMPLETE" && t.state !== "NOT_REQUIRED",
  );
  const trainingIncomplete = openTrainings.length + (learningTask ? 1 : 0);
  const trainingHref = openTrainings.length > 0 ? "/training" : learningTask ? "/learning" : "/training";
  const profileTask = onboarding.tasks.find((t) => t.key === "profile");

  // Navigational shortcuts, only shown when there aren't enough real actions.
  const backfill: ActionCard[] = [];
  for (const id of ["volunteers", "recruitment"] as const) {
    const m = activeModules.find((mm) => mm.id === id);
    if (m) {
      backfill.push({ key: m.id, href: `/${m.id}`, icon: m.icon, hue: HUE_BY_MODULE[m.id] ?? "schedule", label: m.title, sub: m.description, priority: 0 });
    }
  }
  if (isPanelist) {
    backfill.push({ key: "my-interviews", href: "/recruitment/interviews", icon: ClipboardList, hue: "recruit", label: "My interviews", sub: "Panel assignments", priority: 0 });
  }
  const adminModule = activeModules.find((mm) => mm.id === "admin");
  if (adminModule) {
    backfill.push({ key: "admin", href: "/admin", icon: adminModule.icon, hue: HUE_BY_MODULE.admin, label: adminModule.title, sub: adminModule.description, priority: 0 });
  }

  const cards = buildActionCards({
    hasScheduleAccess: accessible.has("schedule"),
    hasMyInfoAccess: accessible.has("my-info"),
    // Both counts span BOTH kinds of commitment, so the Schedule card reads
    // "In 3 days" for an attending covering next Saturday instead of the
    // "View shifts" it showed while their real schedule sat one click away.
    upcomingCount: upcoming.length + attendingUpcoming.length,
    nextShiftDaysAway: next ? daysAway : null,
    // Attending requests count too: the card they land on lists both, and a
    // pending drop is a pending drop.
    pendingSwapCount:
      (liveEntry?.pendingRequests.size ?? 0) + (attendingSchedule?.pendingRequests.size ?? 0),
    pendingApprovals,
    compliance: status,
    trainingIncomplete,
    trainingHref,
    profileIncomplete: profileTask?.state === "INCOMPLETE",
    // Faculty are not on the volunteer clearance track, so the My info card must
    // not lead with "Upload HIPAA certificate" -- at priority 90 that was the TOP
    // card of an attending's feed, pointing at a requirement they hold no shift
    // under and that Faculty Relations tracks on AttendingCredentialing. Same
    // wrong claim as the clearance card above, on a different surface. The card
    // itself still appears; it just falls back to "View & update".
    suppressComplianceNudge: isFaculty,
    backfill,
  });

  // Clinic check-in gets its own banner above the action feed rather than a tile
  // inside it. In the tile grid it rendered identically to the navigation
  // shortcuts (same size, same weight), so on a clinic morning the one
  // time-sensitive action on the page read as another shortcut. Priority bought
  // it the leftmost slot, which is position, not prominence.
  //
  // Gated on actually being scheduled: a banner for an unscheduled person would
  // dead-end on the check-in page's NOT_ASSIGNED refusal.
  const showCheckInBanner =
    accessible.has("schedule") && checkIn.clinicDate !== null && checkIn.assignmentCount > 0;
  // checkedInAt is a real instant (not a calendar marker like clinicDate), so it
  // renders in the configurable display zone rather than the server's own zone,
  // matching how every other instant in the app is shown.
  const checkedInLabel = checkIn.existing
    ? formatTimeOnly(checkIn.existing.checkedInAt, await getDisplayTimeZone(), {
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  return (
    <>
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_340px]">
        {/* Main column */}
        <div className="min-w-0">
          {/* Greeting */}
          <div className="mb-6">
            <p className="text-[11px] font-bold uppercase tracking-[0.09em] text-muted-foreground">{eyebrow}</p>
            <h1 className="mt-2 text-3xl font-bold leading-tight tracking-tight text-foreground">
              <TimeGreeting initial={timeGreeting()} />
              {firstName ? (
                <>
                  , <span className="text-brand-fg">{firstName}</span>
                </>
              ) : null}
              .
            </h1>
            <p className="mt-2 text-[15px] text-foreground-soft">Here&apos;s what&apos;s happening at the clinic this week.</p>
          </div>

          {/* Next shift hero (real data) or calm empty state */}
          {next ? (
            <div className="relative overflow-hidden rounded-2xl border border-brand-deep bg-gradient-to-br from-brand to-brand-deep p-6 text-white shadow-md">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-white/70">
                    <CalendarDays aria-hidden className="h-3.5 w-3.5" /> Your next shift
                  </span>
                  <p className="mt-2.5 text-2xl font-bold leading-tight tracking-tight">{fmtLongDate(next.clinicDate)}</p>
                  <p className="mt-1 text-sm text-white/80">{next.where}</p>
                </div>
                <div className="shrink-0 rounded-xl border border-white/15 bg-white/10 px-4 py-2.5 text-center">
                  {daysAway <= 0 ? (
                    <p className="text-lg font-bold leading-tight">Today</p>
                  ) : (
                    <>
                      <p className="text-2xl font-bold leading-none">{daysAway}</p>
                      <p className="mt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-white/70">
                        {daysAway === 1 ? "day away" : "days away"}
                      </p>
                    </>
                  )}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/15 pt-4 text-sm text-white/90">
                <span className="inline-flex items-center gap-2">
                  <Stethoscope aria-hidden className="h-4 w-4 text-white/70" /> {next.role}
                </span>
                {nextTags.length > 0 && (
                  <span className="inline-flex items-center gap-2">
                    <Repeat aria-hidden className="h-4 w-4 text-white/70" /> {nextTags.join(" · ")}
                  </span>
                )}
                {/* The attending covering THIS member's department that day.
                    Omitted entirely when there is none -- an unstaffed column,
                    a department that maps to no column, or a schedule not
                    published yet all read as "not announced", which is honest,
                    where an empty "Attending:" label would read as a gap. */}
                {next.attendings.length > 0 && (
                  <span className="inline-flex items-center gap-2">
                    <UserRound aria-hidden className="h-4 w-4 text-white/70" />
                    {next.attendings.length > 1 ? "Attendings" : "Attending"}:{" "}
                    {next.attendings.join(", ")}
                  </span>
                )}
              </div>

              {accessible.has("schedule") && (
                <div className="mt-5 flex flex-wrap gap-2.5">
                  <Link
                    href="/schedule"
                    className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-brand transition hover:bg-white/90"
                  >
                    View my schedule <ArrowRight aria-hidden className="h-4 w-4" />
                  </Link>
                </div>
              )}
            </div>
          ) : (
            <Card pad={false} className="p-6">
              <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-subtle-foreground">
                <CalendarDays aria-hidden className="h-3.5 w-3.5" /> Your schedule
              </span>
              <p className="mt-2.5 text-lg font-semibold text-foreground">No upcoming shifts</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {term
                  ? `You have no shifts scheduled for the rest of ${term.name}.`
                  : "There's no active term right now."}
              </p>
              {accessible.has("schedule") && (
                <div className="mt-4">
                  <Link
                    href="/schedule"
                    className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-hover"
                  >
                    Go to my schedule <ArrowRight aria-hidden className="h-4 w-4" />
                  </Link>
                </div>
              )}
            </Card>
          )}

          {/* Clinic check-in: prompt, then a quiet confirmation once checked in. */}
          {showCheckInBanner && (
            <Card pad={false} className="mt-4 p-5">
              {checkedInLabel ? (
                <div className="flex items-center gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-success-foreground">
                    <Check aria-hidden className="h-[18px] w-[18px]" />
                  </span>
                  <p className="text-sm font-semibold text-muted-foreground">
                    Checked in at {checkedInLabel}
                  </p>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-light text-brand-fg">
                      <ClipboardCheck aria-hidden className="h-[18px] w-[18px]" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-lg font-semibold text-foreground">Clinic today</p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        Check in when you arrive at the clinic.
                      </p>
                    </div>
                  </div>
                  <Link
                    href="/schedule/check-in"
                    className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-hover"
                  >
                    Check in <ArrowRight aria-hidden className="h-4 w-4" />
                  </Link>
                </div>
              )}
            </Card>
          )}

          {/* Action feed */}
          {cards.length > 0 && (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {cards.map((card) => {
                const Icon = card.icon;
                return (
                  <Link
                    key={card.key}
                    href={card.href}
                    style={hueVars(card.hue)}
                    className={cardClasses({ size: "compact", interactive: true, pad: false }) + " flex items-center gap-3 p-3.5"}
                  >
                    <span
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
                      style={{ color: "var(--mh)", background: "var(--mhbg)" }}
                    >
                      <Icon aria-hidden className="h-[18px] w-[18px]" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-foreground">{card.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">{card.sub}</span>
                    </span>
                  </Link>
                );
              })}
            </div>
          )}

          {/* Modules */}
          <div className="mt-9 mb-3 flex items-baseline justify-between">
            <h2 className="text-base font-bold tracking-tight text-foreground">Modules</h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {activeModules.map((m) => (
              <ModuleTile key={m.id} m={m} />
            ))}
          </div>
        </div>

        {/* Side rail (real data only) */}
        <aside className="flex flex-col gap-4 lg:sticky lg:top-20">
          {/* Streams in independently: the clinic channel link hits Microsoft
              Graph (seconds), so it must not block the rest of the dashboard. */}
          <Suspense fallback={null}>
            <ClinicChannelCard />
          </Suspense>

          <EpicAccessCard personId={person.personId} />

          {/* Dropped entirely when there is nothing to say, rather than rendered
              as an empty card. Currently that is faculty with no volunteer
              membership; see the statusGroups fallbacks. */}
          {statusGroups.length > 0 && (
          <Card>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-subtle-foreground">Your status</h3>
              {statusGroups.length === 1 && statusGroups[0].hasTasks && (
                <span
                  className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
                    statusGroups[0].cleared ? "text-success-foreground" : "text-warning-foreground"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`h-1.5 w-1.5 rounded-full ${statusGroups[0].cleared ? "bg-success" : "bg-warning"}`}
                  />
                  {statusGroups[0].cleared ? "Cleared" : "Not yet cleared"}
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-col gap-4">
              {statusGroups.map((group) => (
                <div key={group.termId}>
                  {statusGroups.length > 1 && group.termName && (
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-foreground-soft">{group.termName}</span>
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
                          group.cleared ? "text-success-foreground" : "text-warning-foreground"
                        }`}
                      >
                        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${group.cleared ? "bg-success" : "bg-warning"}`} />
                        {group.cleared ? "Cleared" : "Not yet cleared"}
                      </span>
                    </div>
                  )}
                  {group.lines.map((line, i) => (
                    <Link
                      key={`${group.termId}-${i}`}
                      href={line.href}
                      className="flex items-center gap-3 border-t border-border-subtle py-2.5 first:border-t-0 first:pt-1"
                    >
                      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${line.ok ? "bg-success text-white" : "bg-warning text-white"}`}>
                        {line.ok ? <Check aria-hidden className="h-4 w-4" /> : <Clock aria-hidden className="h-4 w-4" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-foreground">{line.title}</span>
                        <span className="block text-xs text-muted-foreground">{line.sub}</span>
                      </span>
                      <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-subtle-foreground" />
                    </Link>
                  ))}
                </div>
              ))}
            </div>
          </Card>
          )}
        </aside>
      </div>
    </>
  );
}
