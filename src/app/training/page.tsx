import Link from "next/link";
import {
  Award,
  Lock,
  Clock,
  AlertTriangle,
  PlayCircle,
  FileText,
  CalendarDays,
  CheckCircle2,
  Check,
  MessagesSquare,
} from "lucide-react";
import type { TrainingMethod } from "@prisma/client";
import { requirePersonSession } from "@/platform/auth/session";
import { AppShell } from "@/platform/ui/app-shell";
import { getAccessibleModules } from "@/platform/modules/access";
import { getMyTraining, type MyTraining } from "@/modules/recruitment/services/training";
import { TrainingQuiz } from "./training-quiz";

/** "live session" / "quiz" for human-readable copy. */
function viaLabel(via: TrainingMethod | null): string {
  if (via === "ATTENDANCE") return "live session";
  if (via === "QUIZ") return "quiz";
  return "";
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// ---------------------------------------------------------------------------
// Clearance hero — the one thing that matters: am I cleared for the term?
// ---------------------------------------------------------------------------

function ClearanceHero({ my }: { my: MyTraining }) {
  const term = my.term.name;

  if (my.state === "COMPLETE") {
    return (
      <div className="mb-6 flex items-center gap-[18px] rounded-2xl border border-green-300 bg-green-50 px-[22px] py-5 shadow-sm">
        <span className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-[13px] bg-success text-white">
          <Award aria-hidden className="h-[26px] w-[26px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-wider text-success">Cleared for the term</p>
          <p className="mt-0.5 text-[19px] font-bold tracking-tight text-slate-800">You&apos;re all set for {term}</p>
          <p className="mt-1 text-[13.5px] leading-snug text-slate-600">
            Training complete{my.completedVia ? ` via ${viaLabel(my.completedVia)}` : ""}. You meet the training
            requirement and can be scheduled for shifts.
          </p>
        </div>
        {my.completedAt && (
          <span className="shrink-0 whitespace-nowrap rounded-full border border-slate-200 bg-white/70 px-3 py-1.5 text-[12.5px] font-semibold text-slate-600">
            Completed {fmtDate(my.completedAt)}
          </span>
        )}
      </div>
    );
  }

  if (my.locked) {
    return (
      <div className="mb-6 flex items-center gap-[18px] rounded-2xl border border-red-300 bg-red-50 px-[22px] py-5 shadow-sm">
        <span className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-[13px] border border-red-300 bg-white text-critical">
          <Lock aria-hidden className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-wider text-critical">Quiz locked</p>
          <p className="mt-0.5 text-[19px] font-bold tracking-tight text-slate-800">
            You&apos;ve used all {my.maxAttempts} quiz attempts
          </p>
          <p className="mt-1 text-[13.5px] leading-snug text-slate-600">
            Your makeup quiz is locked. Contact your recruitment director to reset it, or attend a live session to
            complete training.
          </p>
        </div>
        <span className="shrink-0 whitespace-nowrap rounded-full border border-slate-200 bg-white/70 px-3 py-1.5 text-[12.5px] font-semibold text-slate-600">
          Action needed
        </span>
      </div>
    );
  }

  if (!my.cycle) {
    return (
      <div className="mb-6 flex items-center gap-[18px] rounded-2xl border border-border bg-surface px-[22px] py-5 shadow-sm">
        <span className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-[13px] bg-muted-strong text-muted-foreground">
          <Clock aria-hidden className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Not open yet</p>
          <p className="mt-0.5 text-[19px] font-bold tracking-tight text-foreground">Training opens soon</p>
          <p className="mt-1 text-[13.5px] leading-snug text-foreground-soft">
            Volunteer training for {term} isn&apos;t open yet. You&apos;ll get an email when it&apos;s ready — check back
            here to complete it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-6 flex items-center gap-[18px] rounded-2xl border border-amber-300 bg-amber-50 px-[22px] py-5 shadow-sm">
      <span className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-[13px] border border-amber-300 bg-white text-warning">
        <AlertTriangle aria-hidden className="h-6 w-6" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold uppercase tracking-wider text-warning">Not yet cleared</p>
        <p className="mt-0.5 text-[19px] font-bold tracking-tight text-slate-800">
          Complete training to be cleared for {term}
        </p>
        <p className="mt-1 text-[13.5px] leading-snug text-slate-600">
          Finish one of the two paths below. Most volunteers attend the live session — the makeup quiz is here if you
          miss it.
        </p>
      </div>
      <span className="shrink-0 whitespace-nowrap rounded-full border border-slate-200 bg-white/70 px-3 py-1.5 text-[12.5px] font-semibold text-slate-600">
        Due before your first shift
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Two completion paths
// ---------------------------------------------------------------------------

function PathCards({ my }: { my: MyTraining }) {
  return (
    <>
      <SectionHead>Two ways to complete</SectionHead>
      <div className="mb-2 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <div className="relative rounded-2xl border border-brand/40 bg-surface p-[18px] ring-1 ring-inset ring-brand/20">
          <span className="absolute right-3.5 top-3.5 rounded-full bg-brand-faint px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-brand-fg">
            Recommended
          </span>
          <div className="mb-3 flex items-center gap-3">
            <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] bg-brand-faint text-brand-fg">
              <PlayCircle aria-hidden className="h-5 w-5" />
            </span>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Path 1</p>
              <p className="mt-px text-[15px] font-bold leading-tight text-foreground">Attend the live session</p>
            </div>
          </div>
          <p className="text-[13px] leading-relaxed text-foreground-soft">
            Join the in-person orientation. Your director marks your attendance and you&apos;re cleared automatically —
            no quiz needed.
          </p>
          <p className="mt-3 flex items-center gap-2 border-t border-border pt-3 text-[12.5px] font-semibold text-foreground">
            <CalendarDays aria-hidden className="h-[15px] w-[15px] shrink-0 text-brand-fg" /> Recorded by your director at the
            session
          </p>
        </div>

        <div className="relative rounded-2xl border border-border bg-surface p-[18px]">
          <div className="mb-3 flex items-center gap-3">
            <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] bg-brand-faint text-brand-fg">
              <FileText aria-hidden className="h-5 w-5" />
            </span>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Path 2</p>
              <p className="mt-px text-[15px] font-bold leading-tight text-foreground">Take the makeup quiz</p>
            </div>
          </div>
          <p className="text-[13px] leading-relaxed text-foreground-soft">
            Missed the session? Review the handbook and pass the short quiz below to clear the requirement on your own
            time.
          </p>
          <p className="mt-3 flex items-center gap-2 border-t border-border pt-3 text-[12.5px] font-semibold text-foreground">
            <CheckCircle2 aria-hidden className="h-[15px] w-[15px] shrink-0 text-brand-fg" /> Need {my.passPercent}% to pass ·{" "}
            {my.maxAttempts} attempts
          </p>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Complete / locked detail panels
// ---------------------------------------------------------------------------

function CompleteDetail({ accessibleSchedule }: { accessibleSchedule: boolean }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-[22px] shadow-sm">
      <h3 className="mb-3.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">What this unlocks</h3>
      <DetailRow tone="success" title="Eligible for shift scheduling" sub="You can now be assigned to clinic shifts" />
      <DetailRow tone="success" title="Training requirement met" sub="Shows as cleared on your volunteer compliance" />
      <div className="mt-[18px] flex flex-wrap gap-2.5">
        {accessibleSchedule && (
          <Link
            href="/schedule"
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-[13.5px] font-semibold text-white shadow-sm transition hover:bg-brand-hover"
          >
            <CalendarDays aria-hidden className="h-4 w-4" /> View the schedule
          </Link>
        )}
        <BackToHub />
      </div>
    </div>
  );
}

function LockedDetail() {
  return (
    <div className="rounded-2xl border border-border bg-surface p-[22px] shadow-sm">
      <h3 className="mb-3.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">Next steps</h3>
      <DetailRow
        tone="brand"
        icon={<MessagesSquare aria-hidden className="h-4 w-4" />}
        title="Contact your recruitment director"
        sub="They can reset your quiz attempts"
      />
      <DetailRow
        tone="brand"
        icon={<PlayCircle aria-hidden className="h-4 w-4" />}
        title="Or attend the live session"
        sub="Your director records attendance — clears training instantly"
      />
      <div className="mt-[18px]">
        <BackToHub />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3.5 mt-7 flex items-baseline justify-between">
      <h2 className="text-base font-bold tracking-tight text-foreground">{children}</h2>
    </div>
  );
}

function DetailRow({
  tone,
  title,
  sub,
  icon,
}: {
  tone: "success" | "brand";
  title: string;
  sub: string;
  icon?: React.ReactNode;
}) {
  const toneClass = tone === "success" ? "bg-green-50 text-success" : "bg-brand-faint text-brand-fg";
  return (
    <div className="flex items-center gap-3 border-t border-border-subtle py-2.5 first:border-t-0 first:pt-0">
      <span className={`grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg ${toneClass}`}>
        {icon ?? <Check aria-hidden className="h-4 w-4" />}
      </span>
      <div className="min-w-0">
        <p className="text-[13.5px] font-semibold text-foreground">{title}</p>
        <p className="mt-px text-[12.5px] text-muted-foreground">{sub}</p>
      </div>
    </div>
  );
}

function BackToHub() {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-2 rounded-lg border border-border-strong bg-surface px-4 py-2.5 text-[13.5px] font-semibold text-foreground transition hover:border-border-strong hover:bg-muted"
    >
      Back to hub
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function TrainingPage() {
  const person = await requirePersonSession();
  const my = await getMyTraining(person.personId);
  const pending = my.cycle && my.state !== "COMPLETE" && !my.locked;
  const canSchedule =
    my.state === "COMPLETE" &&
    (await getAccessibleModules(person.personId)).some((m) => m.id === "schedule");

  return (
    <AppShell userName={person.name} termLabel={my.term.name} personId={person.personId} personThemePreference={person.themePreference}>
      <div className="max-w-[760px]">
        <header className="mb-[22px]">
          <h1 className="text-[26px] font-bold tracking-tight text-foreground">Volunteer Training</h1>
          <p className="mt-1.5 text-[14.5px] text-foreground-soft">Complete training to be cleared for {my.term.name}.</p>
        </header>

        <ClearanceHero my={my} />

        {pending && (
          <>
            <PathCards my={my} />
            <SectionHead>Makeup quiz</SectionHead>
            <TrainingQuiz
              questions={my.questions}
              passPercent={my.passPercent}
              maxAttempts={my.maxAttempts}
              attemptsUsed={my.attemptsUsed}
              intake={my.intake}
            />
            <div className="mt-[18px] flex justify-end">
              <BackToHub />
            </div>
          </>
        )}

        {my.state === "COMPLETE" && <CompleteDetail accessibleSchedule={canSchedule} />}

        {my.locked && my.state !== "COMPLETE" && <LockedDetail />}

        {!my.cycle && my.state !== "COMPLETE" && (
          <div className="flex justify-start">
            <BackToHub />
          </div>
        )}
      </div>
    </AppShell>
  );
}
