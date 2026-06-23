import { Suspense, type CSSProperties } from "react";
import Link from "next/link";
import {
  CalendarDays,
  UserRoundPen,
  Users,
  ClipboardList,
  Settings,
  Stethoscope,
  ArrowRight,
  Repeat,
  Check,
  Clock,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { requirePersonSession } from "@/platform/auth/session";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { MODULES } from "@/platform/modules/registry";
import { canAccessModule } from "@/platform/modules/access";
import type { ModuleManifest } from "@/platform/modules/types";
import { TimeGreeting } from "@/platform/ui/time-greeting";
import { ClinicChannelCard } from "./clinic-channel-card";
import { mySchedule } from "@/modules/schedule/services/schedule";
import { listMyCertificates } from "@/modules/my-info/services/my-info";
import { resolveTrainingState } from "@/modules/recruitment/services/training";
import { complianceStatus, certExpiresAt } from "@/platform/compliance/rules";
import { isoDateKey } from "@/platform/dates";

// ---------------------------------------------------------------------------
// Presentation helpers (pure)
// ---------------------------------------------------------------------------

/** Per-module accent hue key; drives the colored icon tile + left swatch. */
const HUE_BY_MODULE: Record<string, string> = {
  schedule: "schedule",
  "my-info": "info",
  volunteers: "volunteers",
  recruitment: "recruit",
  admin: "admin",
  triage: "schedule",
  referrals: "info",
  "patient-trackers": "volunteers",
};

/** Inline CSS vars so Tailwind's static scan never has to see dynamic hues. */
function hueStyle(id: string): CSSProperties {
  const hue = HUE_BY_MODULE[id] ?? "schedule";
  return {
    ["--mh" as string]: `var(--mod-${hue})`,
    ["--mhbg" as string]: `var(--mod-${hue}-bg)`,
  } as CSSProperties;
}

function timeGreeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/** "Saturday, June 13" — clinic dates are stored at noon UTC, so format in UTC. */
function fmtLongDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "Aug 2026" */
function fmtMonthYear(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
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

// ---------------------------------------------------------------------------
// Module tile
// ---------------------------------------------------------------------------

function ModuleTile({ m }: { m: ModuleManifest }) {
  const Icon = m.icon;

  if (m.status !== "active") {
    return (
      <div className="relative flex items-start gap-4 overflow-hidden rounded-2xl border border-border bg-muted p-[18px]">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-muted-strong/70 text-subtle-foreground">
          <Icon aria-hidden className="h-[22px] w-[22px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-[15px] font-bold text-muted-foreground">{m.title}</span>
            <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-subtle-foreground">
              Soon
            </span>
          </span>
          <span className="mt-1 block text-[13px] leading-relaxed text-subtle-foreground">{m.description}</span>
        </span>
      </div>
    );
  }

  return (
    <Link
      href={`/${m.id}`}
      aria-label={`Open ${m.title}`}
      style={hueStyle(m.id)}
      className="group relative flex items-start gap-4 overflow-hidden rounded-2xl border border-border bg-surface p-[18px] transition hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md"
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

/**
 * The hub lives at the root: the deployed domain is hub.havenfreeclinic.org,
 * so "/" is the landing page for signed-in members. Unauthenticated visitors
 * are redirected to /login by requirePersonSession.
 *
 * The home is a personalized dashboard: a greeting, the member's next shift,
 * quick actions, color-coded module tiles, and a side rail with this week's
 * clinic channel and their real compliance status.
 */
export default async function HubPage() {
  const person = await requirePersonSession();
  // One permission fetch per render; tiles filter in memory (never can() in a loop).
  const permissions = await getEffectivePermissions(person.personId);

  const [schedule, certificates] = await Promise.all([
    mySchedule(person.personId),
    listMyCertificates(person.personId),
  ]);
  const { term, shifts } = schedule;
  const trainingState = term ? await resolveTrainingState(person.personId, term.id) : "PENDING";

  // --- Module visibility (unchanged rules) ---
  const visible = MODULES.filter(
    (m) => m.status === "coming-soon" || canAccessModule(m, permissions)
  );
  const activeModules = visible.filter((m) => m.status === "active");
  const soonModules = visible.filter((m) => m.status !== "active");
  const accessible = new Set(activeModules.map((m) => m.id));

  // --- Next shift ---
  const todayKey = isoDateKey(new Date());
  const upcoming = shifts.filter((s) => isoDateKey(s.clinicDate) >= todayKey);
  const next = upcoming[0] ?? null;
  const daysAway = next ? daysBetweenKeys(todayKey, isoDateKey(next.clinicDate)) : 0;
  const nextTags = next ? shiftTags(next.tags) : [];

  // --- Greeting context ---
  const firstName = person.name ? person.name.trim().split(/\s+/)[0] : null;
  const dept = next?.department.name ?? shifts[0]?.department.name ?? null;
  const eyebrow = [term?.name, dept].filter(Boolean).join(" · ") || "HAVEN Free Clinic";

  // --- Compliance status (real data, same rules as My Info) ---
  const newestCert = certificates[0] ?? null;
  const status = complianceStatus(newestCert, term?.endDate ?? null);
  const expiry =
    newestCert?.completionDate != null ? fmtMonthYear(certExpiresAt(newestCert.completionDate)) : null;

  const hipaaLine =
    status === "COMPLIANT"
      ? { ok: true, title: "HIPAA training current", sub: expiry ? `Valid through ${expiry}` : "On file" }
      : status === "EXPIRING_SOON"
        ? { ok: false, title: "HIPAA training expiring soon", sub: expiry ? `Renew before ${expiry}` : "Renew soon" }
        : status === "EXPIRED"
          ? { ok: false, title: "HIPAA training expired", sub: "Upload a current certificate" }
          : status === "UNKNOWN_DATE"
            ? { ok: false, title: "Add your HIPAA completion date", sub: "Certificate on file, date missing" }
            : { ok: false, title: "Upload your HIPAA certificate", sub: "Required for clinic clearance" };

  const trainingLine =
    trainingState === "COMPLETE"
      ? { ok: true, title: "Volunteer training complete", sub: "You're cleared for this term" }
      : { ok: false, title: "Complete your volunteer training", sub: "Required to be cleared" };

  const statusLines: Array<{ ok: boolean; title: string; sub: string; href: string }> = [
    { ...hipaaLine, href: "/my-info" },
    ...(term ? [{ ...trainingLine, href: "/training" }] : []),
  ];

  // --- Quick actions (real links, access-filtered, capped at 4) ---
  const hipaaShort = status === "COMPLIANT" ? "current" : "action needed";
  const quickAll: Array<{ id: string; show: boolean; href: string; Icon: LucideIcon; label: string; sub: string }> = [
    {
      id: "schedule",
      show: accessible.has("schedule"),
      href: "/schedule",
      Icon: CalendarDays,
      label: "My schedule",
      sub: upcoming.length ? `${upcoming.length} upcoming` : "View shifts",
    },
    {
      id: "my-info",
      show: accessible.has("my-info"),
      href: "/my-info",
      Icon: UserRoundPen,
      label: "My info",
      sub: `HIPAA ${hipaaShort}`,
    },
    {
      id: "volunteers",
      show: accessible.has("volunteers"),
      href: "/volunteers",
      Icon: Users,
      label: "Volunteers",
      sub: "Rosters & compliance",
    },
    {
      id: "recruitment",
      show: accessible.has("recruitment"),
      href: "/recruitment",
      Icon: ClipboardList,
      label: "Recruitment",
      sub: "Cycles & review",
    },
    {
      id: "admin",
      show: accessible.has("admin"),
      href: "/admin",
      Icon: Settings,
      label: "Admin",
      sub: "People & terms",
    },
  ];
  const quick = quickAll.filter((q) => q.show).slice(0, 4);

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
                  <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-light">
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
                      <p className="mt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-brand-light">
                        {daysAway === 1 ? "day away" : "days away"}
                      </p>
                    </>
                  )}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/15 pt-4 text-sm text-white/90">
                <span className="inline-flex items-center gap-2">
                  <Stethoscope aria-hidden className="h-4 w-4 text-brand-light" /> {roleLabel(next.role)}
                </span>
                {nextTags.length > 0 && (
                  <span className="inline-flex items-center gap-2">
                    <Repeat aria-hidden className="h-4 w-4 text-brand-light" /> {nextTags.join(" · ")}
                  </span>
                )}
              </div>

              <div className="mt-5 flex flex-wrap gap-2.5">
                <Link
                  href="/schedule"
                  className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-brand transition hover:bg-brand-faint"
                >
                  View my schedule <ArrowRight aria-hidden className="h-4 w-4" />
                </Link>
                <Link
                  href="/schedule"
                  className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/20"
                >
                  <Repeat aria-hidden className="h-4 w-4" /> Request a change
                </Link>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-border bg-surface p-6">
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
            </div>
          )}

          {/* Quick actions */}
          {quick.length > 0 && (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {quick.map((q) => {
                const Icon = q.Icon;
                return (
                  <Link
                    key={q.id}
                    href={q.href}
                    style={hueStyle(q.id)}
                    className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3.5 transition hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md"
                  >
                    <span
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
                      style={{ color: "var(--mh)", background: "var(--mhbg)" }}
                    >
                      <Icon aria-hidden className="h-[18px] w-[18px]" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-foreground">{q.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">{q.sub}</span>
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

          {soonModules.length > 0 && (
            <>
              <h2 className="mt-8 mb-3 text-base font-bold tracking-tight text-muted-foreground">On the roadmap</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {soonModules.map((m) => (
                  <ModuleTile key={m.id} m={m} />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Side rail (real data only) */}
        <aside className="flex flex-col gap-4 lg:sticky lg:top-20">
          {/* Streams in independently: the clinic channel link hits Microsoft
              Graph (seconds), so it must not block the rest of the dashboard. */}
          <Suspense fallback={null}>
            <ClinicChannelCard />
          </Suspense>

          <div className="rounded-2xl border border-border bg-surface p-5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-subtle-foreground">Your status</h3>
            <div className="mt-2">
              {statusLines.map((line) => (
                <Link
                  key={line.title}
                  href={line.href}
                  className="flex items-center gap-3 border-t border-border-subtle py-2.5 first:border-t-0 first:pt-1"
                >
                  <span
                    className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${
                      line.ok ? "bg-green-50 text-success" : "bg-amber-50 text-warning"
                    }`}
                  >
                    {line.ok ? (
                      <Check aria-hidden className="h-4 w-4" />
                    ) : (
                      <Clock aria-hidden className="h-4 w-4" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-foreground">{line.title}</span>
                    <span className="block text-xs text-muted-foreground">{line.sub}</span>
                  </span>
                  <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-subtle-foreground" />
                </Link>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
