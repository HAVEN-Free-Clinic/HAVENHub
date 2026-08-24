import type { CSSProperties } from "react";
import Link from "next/link";
import { Check, UserRoundPen, ShieldCheck, GraduationCap, BookOpen, HardHat, type LucideIcon } from "lucide-react";
import { Badge } from "@/platform/ui/badge";
import { buttonClasses } from "@/platform/ui/button";
import type { OnboardingTask } from "@/modules/onboarding/services/onboarding";
import type { OnboardingTaskKey, OnboardingTaskState } from "@/modules/onboarding/engine/status";
import { ExternalLinkButton } from "@/platform/ui/external-link-button";
import type { MyEhsItem } from "@/platform/ehs/services/my-ehs";
import { ehsCompletionLabel } from "@/platform/ehs/completion-link";

const ICON: Record<OnboardingTaskKey, LucideIcon> = {
  profile: UserRoundPen,
  hipaa: ShieldCheck,
  training: GraduationCap,
  directorTraining: GraduationCap,
  learning: BookOpen,
  ehs: HardHat,
};

/** Each task tile gets one quiet module hue. */
const HUE: Record<OnboardingTaskKey, string> = {
  profile: "volunteers",
  hipaa: "info",
  training: "recruit",
  directorTraining: "schedule",
  learning: "admin",
  ehs: "info",
};

function hueStyle(key: OnboardingTaskKey): CSSProperties {
  return {
    ["--mh" as string]: `var(--mod-${HUE[key]})`,
    ["--mhbg" as string]: `var(--mod-${HUE[key]}-bg)`,
  } as CSSProperties;
}

function StatusPill({ state, actionable }: { state: OnboardingTaskState; actionable: boolean }) {
  if (state === "COMPLETE") return <Badge tone="success">Done</Badge>;
  if (state === "NOT_REQUIRED") return <Badge tone="default">Not required</Badge>;
  if (state === "IN_PROGRESS") return <Badge tone="brand">In progress</Badge>;
  // A task with no CTA at all (neither an internal fix-it link nor an external
  // one) is not something the member can act on, so "Action needed" would
  // misdirect them. Show a neutral "Pending" instead of the warning-toned CTA.
  if (!actionable) return <Badge tone="default">Pending</Badge>;
  return <Badge tone="warning">Action needed</Badge>;
}

function TaskRow({ task, ehsItems }: { task: OnboardingTask; ehsItems: MyEhsItem[] }) {
  const Icon = ICON[task.key];
  const done = task.state === "COMPLETE" || task.state === "NOT_REQUIRED";
  // EHS is recorded by a coordinator (no internal href), but the volunteer still
  // has to go do each item, so the tile lists the outstanding ones with their own
  // links and counts as actionable. Naming them matters: this used to be a single
  // "Complete in Workday" button, which both hid WHICH item was outstanding and
  // pointed at the wrong system for the health requirements, which are done in
  // HealthOnTrack.
  const ehsOutstanding = task.key === "ehs" && !done ? ehsItems.filter((i) => !i.complete) : [];
  // "Added to EHS?" is a coordinator's record, not a member task, so it has no
  // link and does not make the tile actionable, but it still gets listed: knowing
  // what is outstanding is the point even when you cannot act on it yourself.
  const actionable = !!task.href || ehsOutstanding.some((i) => i.completionUrl);
  return (
    <li
      className={`flex gap-4 rounded-2xl border p-4 shadow-sm ${
        ehsOutstanding.length > 0 ? "items-start" : "items-center"
      } ${done ? "border-border bg-muted" : "border-border bg-surface"}`}
    >
      <span
        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl"
        style={{ ...hueStyle(task.key), background: "var(--mhbg)", color: "var(--mh)" }}
      >
        <Icon aria-hidden className="h-[22px] w-[22px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-bold tracking-tight text-foreground">{task.label}</span>
          <StatusPill state={task.state} actionable={actionable} />
        </div>
        <p className="mt-0.5 text-[13px] leading-snug text-foreground-soft">{task.description}</p>
        {ehsOutstanding.length > 0 && (
          <ul className="mt-2.5 space-y-2">
            {ehsOutstanding.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="text-[13px] font-semibold text-foreground">{item.name}</span>
                {item.completionUrl && (
                  <ExternalLinkButton href={item.completionUrl}>
                    {ehsCompletionLabel(item.completionUrl)}
                  </ExternalLinkButton>
                )}
                {item.description && (
                  <p className="w-full text-[12.5px] leading-snug text-foreground-soft">
                    {item.description}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {done ? (
        <div className="flex shrink-0 items-center gap-2">
          {task.state === "COMPLETE" && task.reviewable && task.href ? (
            <Link href={task.href} className={buttonClasses("outline", "sm")} aria-label={`Review ${task.label}`}>
              Review
            </Link>
          ) : null}
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-success text-white">
            <Check aria-hidden className="h-4 w-4" strokeWidth={3} />
          </span>
        </div>
      ) : task.href ? (
        <Link href={task.href} className={buttonClasses(task.state === "INCOMPLETE" ? "primary" : "outline", "sm")}>
          {task.ctaLabel}
        </Link>
      ) : null}
    </li>
  );
}

export function OnboardingChecklist({
  tasks,
  ehsItems = [],
}: {
  tasks: OnboardingTask[];
  ehsItems?: MyEhsItem[];
}) {
  return (
    <ul className="space-y-3">
      {tasks.map((t) => (
        <TaskRow key={t.key} task={t} ehsItems={ehsItems} />
      ))}
    </ul>
  );
}
