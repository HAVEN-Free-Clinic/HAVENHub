import Link from "next/link";
import { Award, Clock, AlertTriangle, CalendarDays, Check } from "lucide-react";
import type { TrainingMethod } from "@prisma/client";
import { Card } from "@/platform/ui/card";
import { StatusBanner } from "@/platform/ui/status-banner";
import { buttonClasses } from "@/platform/ui/button";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { requirePersonSession } from "@/platform/auth/session";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { hubTrail } from "@/platform/ui/breadcrumb-trail";
import { getAccessibleModules } from "@/platform/modules/access";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getMyTraining, type MyTraining } from "@/modules/recruitment/services/training";
import { formatDateOnly } from "@/platform/dates";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { TrainingDaySteps } from "@/modules/recruitment/components/training-day-steps";

/** "live session" / "online course" for human-readable copy. The quiz is
 *  retired, but completions it granted in earlier terms still read that way. */
function viaLabel(via: TrainingMethod | null): string {
  if (via === "ATTENDANCE") return "live session";
  if (via === "QUIZ") return "quiz";
  if (via === "ONLINE_COURSE") return "online course";
  return "";
}

// ---------------------------------------------------------------------------
// Clearance hero (the one thing that matters): am I cleared for the term?
// ---------------------------------------------------------------------------

function ClearanceHero({ my, zone }: { my: MyTraining; zone: string }) {
  const term = my.term.name;

  if (my.state === "COMPLETE") {
    return (
      <StatusBanner
        className="mb-6"
        tone="success"
        icon={Award}
        eyebrow="Cleared for the term"
        title={<>You&apos;re all set for {term}</>}
        description={
          <>
            Training complete{my.completedVia ? ` via ${viaLabel(my.completedVia)}` : ""}. You meet the training
            requirement and can be scheduled for shifts.
          </>
        }
        trailing={my.completedAt ? <>Completed {formatDateOnly(my.completedAt, zone)}</> : undefined}
      />
    );
  }

  if (!my.cycle) {
    return (
      <StatusBanner
        className="mb-6"
        tone="neutral"
        icon={Clock}
        eyebrow="Not open yet"
        title="Training opens soon"
        description={
          <>
            Volunteer training for {term} isn&apos;t open yet. You&apos;ll get an email when it&apos;s ready, check back
            here to complete it.
          </>
        }
      />
    );
  }

  return (
    <StatusBanner
      className="mb-6"
      tone="warning"
      icon={AlertTriangle}
      eyebrow="Not yet cleared"
      title={<>Complete training to be cleared for {term}</>}
      description={
        my.track === "VOLUNTEER"
          ? "Training day has two parts, the morning session and the afternoon mock clinic. What is left for you is below."
          : "Attending the in-person session clears training. What is left for you is below."
      }
      trailing="Due before your first shift"
    />
  );
}

// ---------------------------------------------------------------------------
// Pending / complete detail panels
// ---------------------------------------------------------------------------

/** What a member with training still open reads, part by part. */
function PendingDetail({ my, zone }: { my: MyTraining; zone: string }) {
  return (
    <Card pad={false} className="mt-7 px-5 py-5">
      <SectionHeader className="mb-3">What is left</SectionHeader>
      <TrainingDaySteps my={my} zone={zone} learningBase="/learning" />
    </Card>
  );
}

function CompleteDetail({ accessibleSchedule }: { accessibleSchedule: boolean }) {
  return (
    <Card pad={false} className="p-5">
      <SectionHeader className="mb-3.5">What you can do now</SectionHeader>
      <DetailRow title="Eligible for shift scheduling" sub="You can now be assigned to clinic shifts" />
      <DetailRow title="Training requirement met" sub="Shows as cleared on your volunteer compliance" />
      {accessibleSchedule && (
        <div className="mt-4 flex flex-wrap gap-2.5">
          <Link href="/schedule" className={buttonClasses("primary", "md", "gap-2 shadow-sm")}>
            <CalendarDays aria-hidden className="h-4 w-4" /> View the schedule
          </Link>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

function DetailRow({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="flex items-center gap-3 border-t border-border-subtle py-2.5 first:border-t-0 first:pt-0">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-success text-white">
        <Check aria-hidden className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="mt-px text-xs text-muted-foreground">{sub}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function TrainingPage() {
  const person = await requirePersonSession();
  const trainings = await getMyTraining(person.personId);
  const zone = await getDisplayTimeZone();
  const liveTerm = await getActiveTerm();
  // Scheduling is inherently live-term: an incomplete NEXT-term training (surfaced
  // early for self-serve) must not suppress the live-term "View the schedule" CTA.
  const liveTrainings = liveTerm ? trainings.filter((m) => m.term.id === liveTerm.id) : [];
  const canSchedule =
    liveTrainings.length > 0 &&
    liveTrainings.every((m) => m.state === "COMPLETE") &&
    (await getAccessibleModules(person.personId)).some((m) => m.id === "schedule");

  return (
    <div className="max-w-[760px]">
      {/* /training is a personal page, not a module page: it gates on
          requirePersonSession alone, so `training` matches no module id and the
          registry-derived trail comes back as "Hub" only -- which the bar drops
          entirely, leaving the page with no chrome above the title at all. Two
          crumbs is the whole fix. */}
      <SetBreadcrumb trail={hubTrail({ label: "Training" })} />
      <header className="mb-5">
        <PageHeader
          title="Training"
          description="Complete your training to be cleared for each term you're part of."
        />
      </header>

      {trainings.length === 0 ? (
        <Card pad={false} className="px-5 py-5 text-sm text-foreground-soft">
          You have no training requirements this term.
        </Card>
      ) : (
        trainings.map((my) => {
          const pending = my.cycle && my.state !== "COMPLETE";
          return (
            <section key={`${my.term.id}-${my.track}`} className="mb-9">
              <SectionHeader level="title" className="mb-3">{my.term.name} · {my.trackLabel}</SectionHeader>
              <ClearanceHero my={my} zone={zone} />
              {pending && <PendingDetail my={my} zone={zone} />}
              {my.state === "COMPLETE" && <CompleteDetail accessibleSchedule={canSchedule} />}
            </section>
          );
        })
      )}
      {/* No "Back to Hub" buttons: the breadcrumb above the title is Hub ›
          Training, and a lone outline button under a narrow card, repeated in
          two of the panels as well, read as the page's main action. */}
    </div>
  );
}
