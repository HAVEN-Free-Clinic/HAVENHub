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
import { Card } from "@/platform/ui/card";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { requirePersonSession } from "@/platform/auth/session";
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
// Clearance hero: the one thing that matters: am I cleared for the term?
// ---------------------------------------------------------------------------

function ClearanceHero({ my }: { my: MyTraining }) {
  const term = my.term.name;

  if (my.state === "COMPLETE") {
    return (
      <Card pad={false} className="mb-6 flex items-center gap-[18px] px-[22px] py-5">
        <span className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-[13px] bg-success text-white">
          <Award aria-hidden className="h-[26px] w-[26px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-wider text-success">Cleared for the term</p>
          <p className="mt-0.5 text-[19px] font-bold tracking-tight text-foreground">You&apos;re all set for {term}</p>
          <p className="mt-1 text-[13.5px] leading-snug text-foreground-soft">
            Training complete{my.completedVia ? ` via ${viaLabel(my.completedVia)}` : ""}. You meet the training
            requirement and can be scheduled for shifts.
          </p>
        </div>
        {my.completedAt && (
          <span className="shrink-0 whitespace-nowrap rounded-full border border-border bg-muted px-3 py-1.5 text-[12.5px] font-semibold text-foreground-soft">
            Completed {fmtDate(my.completedAt)}
          </span>
        )}
      </Card>
    );
  }

  if (my.locked) {
    return (
      <Card pad={false} className="mb-6 flex items-center gap-[18px] px-[22px] py-5">
        <span className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-[13px] bg-critical text-white">
          <Lock aria-hidden className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-wider text-critical">Quiz locked</p>
          <p className="mt-0.5 text-[19px] font-bold tracking-tight text-foreground">
            You&apos;ve used all {my.maxAttempts} quiz attempts
          </p>
          <p className="mt-1 text-[13.5px] leading-snug text-foreground-soft">
            Your makeup quiz is locked. Contact your recruitment director to reset it, or attend a live session to
            complete training.
          </p>
        </div>
        <span className="shrink-0 whitespace-nowrap rounded-full border border-border bg-muted px-3 py-1.5 text-[12.5px] font-semibold text-foreground-soft">
          Action needed
        </span>
      </Card>
    );
  }

  if (!my.cycle) {
    return (
      <Card pad={false} className="mb-6 flex items-center gap-[18px] px-[22px] py-5">
        <span className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-[13px] bg-muted-strong text-muted-foreground">
          <Clock aria-hidden className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <SectionHeader>Not open yet</SectionHeader>
          <p className="mt-0.5 text-[19px] font-bold tracking-tight text-foreground">Training opens soon</p>
          <p className="mt-1 text-[13.5px] leading-snug text-foreground-soft">
            Volunteer training for {term} isn&apos;t open yet. You&apos;ll get an email when it&apos;s ready, check back
            here to complete it.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card pad={false} className="mb-6 flex items-center gap-[18px] px-[22px] py-5">
      <span className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-[13px] bg-warning text-white">
        <AlertTriangle aria-hidden className="h-6 w-6" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold uppercase tracking-wider text-warning">Not yet cleared</p>
        <p className="mt-0.5 text-[19px] font-bold tracking-tight text-foreground">
          Complete training to be cleared for {term}
        </p>
        <p className="mt-1 text-[13.5px] leading-snug text-foreground-soft">
          Finish one of the two paths below. Most volunteers attend the live session; the makeup quiz is here if you
          miss it.
        </p>
      </div>
      <span className="shrink-0 whitespace-nowrap rounded-full border border-border bg-muted px-3 py-1.5 text-[12.5px] font-semibold text-foreground-soft">
        Due before your first shift
      </span>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Two completion paths
// ---------------------------------------------------------------------------

function PathCards({ my }: { my: MyTraining }) {
  return (
    <>
      <SectionHeader level="title" className="mb-3.5 mt-7">Two ways to complete</SectionHeader>
      <div className="mb-2 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <div className="relative rounded-2xl border border-brand/40 bg-surface p-[18px] shadow-sm ring-1 ring-inset ring-brand/20">
          <span className="absolute right-3.5 top-3.5 rounded-full bg-brand-faint px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-brand-fg">
            Recommended
          </span>
          <div className="mb-3 flex items-center gap-3">
            <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] bg-brand-faint text-brand-fg">
              <PlayCircle aria-hidden className="h-5 w-5" />
            </span>
            <div>
              <SectionHeader>Path 1</SectionHeader>
              <p className="mt-px text-[15px] font-bold leading-tight text-foreground">Attend the live session</p>
            </div>
          </div>
          <p className="text-[13px] leading-relaxed text-foreground-soft">
            Join the in-person orientation. Your director marks your attendance and you&apos;re cleared automatically,
            no quiz needed.
          </p>
          <p className="mt-3 flex items-center gap-2 border-t border-border pt-3 text-[12.5px] font-semibold text-foreground">
            <CalendarDays aria-hidden className="h-[15px] w-[15px] shrink-0 text-brand-fg" /> Recorded by your director at the
            session
          </p>
        </div>

        <Card pad={false} className="relative p-[18px]">
          <div className="mb-3 flex items-center gap-3">
            <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] bg-brand-faint text-brand-fg">
              <FileText aria-hidden className="h-5 w-5" />
            </span>
            <div>
              <SectionHeader>Path 2</SectionHeader>
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
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Complete / locked detail panels
// ---------------------------------------------------------------------------

function CompleteDetail({ accessibleSchedule }: { accessibleSchedule: boolean }) {
  return (
    <Card pad={false} className="p-[22px]">
      <SectionHeader className="mb-3.5">What this unlocks</SectionHeader>
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
    </Card>
  );
}

function LockedDetail() {
  return (
    <Card pad={false} className="p-[22px]">
      <SectionHeader className="mb-3.5">Next steps</SectionHeader>
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
        sub="Your director records attendance and clears training instantly"
      />
      <div className="mt-[18px]">
        <BackToHub />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

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
  const toneClass = tone === "success" ? "bg-success text-white" : "bg-brand-faint text-brand-fg";
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
  const trainings = await getMyTraining(person.personId);
  const canSchedule =
    trainings.length > 0 &&
    trainings.every((m) => m.state === "COMPLETE") &&
    (await getAccessibleModules(person.personId)).some((m) => m.id === "schedule");

  return (
    <div className="max-w-[760px]">
      <header className="mb-[22px]">
        <PageHeader
          title="Training"
          description={`Complete your training to be cleared${trainings[0] ? ` for ${trainings[0].term.name}` : ""}.`}
        />
      </header>

      {trainings.length === 0 ? (
        <Card pad={false} className="px-[22px] py-5 text-[14px] text-foreground-soft">
          You have no training requirements this term.
        </Card>
      ) : (
        trainings.map((my) => {
          const pending = my.cycle && my.state !== "COMPLETE" && !my.locked;
          return (
            <section key={my.track} className="mb-9">
              <SectionHeader level="title" className="mb-3">{my.trackLabel}</SectionHeader>
              <ClearanceHero my={my} />
              {pending && (
                <>
                  <PathCards my={my} />
                  <SectionHeader level="title" className="mb-3.5 mt-7">Makeup quiz</SectionHeader>
                  <TrainingQuiz
                    track={my.track}
                    questions={my.questions}
                    passPercent={my.passPercent}
                    maxAttempts={my.maxAttempts}
                    attemptsUsed={my.attemptsUsed}
                    intake={my.intake}
                  />
                </>
              )}
              {my.state === "COMPLETE" && <CompleteDetail accessibleSchedule={canSchedule} />}
              {my.locked && my.state !== "COMPLETE" && <LockedDetail />}
            </section>
          );
        })
      )}
      <div className="mt-[18px] flex justify-end">
        <BackToHub />
      </div>
    </div>
  );
}
