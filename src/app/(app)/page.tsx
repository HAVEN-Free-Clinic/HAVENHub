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
} from "lucide-react";
import { requirePersonSession } from "@/platform/auth/session";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { MODULES } from "@/platform/modules/registry";
import { canAccessModule } from "@/platform/modules/access";
import type { ModuleManifest } from "@/platform/modules/types";
import { TimeGreeting } from "@/platform/ui/time-greeting";
import { Card, cardClasses } from "@/platform/ui/card";
import { ClinicChannelCard } from "./clinic-channel-card";
import { mySchedule } from "@/modules/schedule/services/schedule";
import { countPendingApprovals } from "@/modules/schedule/services/requests";
import { buildActionCards, type ActionCard } from "./action-cards";
import { listMyCertificates } from "@/modules/my-info/services/my-info";
import { getOnboardingStatus, getMyOnboarding, type OnboardingTask } from "@/modules/onboarding/services/onboarding";
import { getMyTraining } from "@/modules/recruitment/services/training";
import { isInterviewPanelist } from "@/modules/recruitment/services/interviews";
import { reviewScope } from "@/modules/recruitment/services/review";
import { complianceStatus, certExpiresAt } from "@/platform/compliance/rules";
import { getSetting } from "@/platform/settings/service";
import { isoDateKey, formatCalendarDate, formatForDateInput } from "@/platform/dates";
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

  const [schedule, certificates, isPanelist, orgName, onboarding, myOnboarding, myTraining, pendingApprovals, recruitmentScope, displayZone] = await Promise.all([
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
  ]);
  const { term, shifts } = schedule;

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
  const next = upcoming[0] ?? null;
  const daysAway = next ? daysBetweenKeys(todayKey, isoDateKey(next.clinicDate)) : 0;
  const nextTags = next ? shiftTags(next.tags) : [];

  // --- Greeting context ---
  const firstName = person.name ? person.name.trim().split(/\s+/)[0] : null;
  const dept = next?.department.name ?? shifts[0]?.department.name ?? null;
  const eyebrow = [term?.name, dept].filter(Boolean).join(" · ") || orgName;

  // --- Compliance status (real data, same rules as My Info) ---
  const newestCert = certificates[0] ?? null;
  const status = complianceStatus(newestCert, term?.endDate ?? null);
  const expiry =
    newestCert?.completionDate != null ? fmtMonthYear(certExpiresAt(newestCert.completionDate)) : null;

  // HIPAA sub copy, expiry aware. Reused for the clearance row and the no-term fallback.
  const hipaaSub =
    status === "COMPLIANT"
      ? (expiry ? `Valid through ${expiry}` : "On file")
      : status === "EXPIRING_SOON"
        ? (expiry ? `Renew before ${expiry}` : "Renew soon")
        : status === "EXPIRED"
          ? "Upload a current certificate"
          : status === "UNKNOWN_DATE"
            ? "Completion date pending review"
            : status === "PENDING_VERIFICATION"
              ? "Awaiting verification"
              : "Required for clinic clearance"; // NO_CERTIFICATE

  // One clearance group per term the member belongs to (ACTIVE TermMembership).
  // Two fallbacks for viewers with no such membership: if a live term exists,
  // mirror the old single-group live-term checklist (getOnboardingStatus already
  // computes profile/HIPAA/learning/EHS off the live term regardless of
  // membership); otherwise fall back to a bare HIPAA line with no pill.
  const statusGroups = myOnboarding.length > 0
    ? myOnboarding.map((entry) => ({
        termId: entry.term.id,
        termName: entry.term.name,
        cleared: entry.status.cleared,
        hasTasks: true,
        lines: entry.status.tasks.filter((t) => t.state !== "NOT_REQUIRED").map((t) => clearanceRow(t, hipaaSub)),
      }))
    : onboarding.hasActiveTerm
      ? [{
          termId: "live",
          termName: "",
          cleared: onboarding.cleared,
          hasTasks: onboarding.tasks.filter((t) => t.state !== "NOT_REQUIRED").length > 0,
          lines: onboarding.tasks.filter((t) => t.state !== "NOT_REQUIRED").map((t) => clearanceRow(t, hipaaSub)),
        }]
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
    upcomingCount: upcoming.length,
    nextShiftDaysAway: next ? daysAway : null,
    pendingSwapCount: schedule.pendingRequests.size,
    pendingApprovals,
    compliance: status,
    trainingIncomplete,
    trainingHref,
    profileIncomplete: profileTask?.state === "INCOMPLETE",
    backfill,
  });

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
                  <p className="mt-1 text-sm text-white/80">{next.department.name}</p>
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
                  <Stethoscope aria-hidden className="h-4 w-4 text-white/70" /> {roleLabel(next.role)}
                </span>
                {nextTags.length > 0 && (
                  <span className="inline-flex items-center gap-2">
                    <Repeat aria-hidden className="h-4 w-4 text-white/70" /> {nextTags.join(" · ")}
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
        </aside>
      </div>
    </>
  );
}
