import type { CSSProperties } from "react";
import Link from "next/link";
import { Check, UserRoundPen, ShieldCheck, GraduationCap, BookOpen, type LucideIcon } from "lucide-react";
import { Badge } from "@/platform/ui/badge";
import { buttonClasses } from "@/platform/ui/button";
import type { OnboardingTask } from "@/modules/onboarding/services/onboarding";
import type { OnboardingTaskKey, OnboardingTaskState } from "@/modules/onboarding/engine/status";

const ICON: Record<OnboardingTaskKey, LucideIcon> = {
  profile: UserRoundPen,
  hipaa: ShieldCheck,
  training: GraduationCap,
  learning: BookOpen,
};

/** Each task tile gets one quiet module hue. */
const HUE: Record<OnboardingTaskKey, string> = {
  profile: "volunteers",
  hipaa: "info",
  training: "recruit",
  learning: "admin",
};

function hueStyle(key: OnboardingTaskKey): CSSProperties {
  return {
    ["--mh" as string]: `var(--mod-${HUE[key]})`,
    ["--mhbg" as string]: `var(--mod-${HUE[key]}-bg)`,
  } as CSSProperties;
}

function StatusPill({ state }: { state: OnboardingTaskState }) {
  if (state === "COMPLETE") return <Badge tone="success">Done</Badge>;
  if (state === "NOT_REQUIRED") return <Badge tone="default">Not required</Badge>;
  if (state === "IN_PROGRESS") return <Badge tone="brand">In progress</Badge>;
  return <Badge tone="warning">Action needed</Badge>;
}

function TaskRow({ task }: { task: OnboardingTask }) {
  const Icon = ICON[task.key];
  const done = task.state === "COMPLETE" || task.state === "NOT_REQUIRED";
  return (
    <li
      className={`flex items-center gap-4 rounded-2xl border p-4 shadow-sm ${
        done ? "border-green-200 bg-green-50/60" : "border-slate-200 bg-white"
      }`}
    >
      <span
        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl"
        style={{ ...hueStyle(task.key), background: "var(--mhbg)", color: "var(--mh)" }}
      >
        <Icon aria-hidden className="h-[22px] w-[22px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-bold tracking-tight text-slate-800">{task.label}</span>
          <StatusPill state={task.state} />
        </div>
        <p className="mt-0.5 text-[13px] leading-snug text-slate-600">{task.description}</p>
      </div>
      {done ? (
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-success text-white">
          <Check aria-hidden className="h-4 w-4" strokeWidth={3} />
        </span>
      ) : (
        <Link href={task.href} className={buttonClasses(task.state === "INCOMPLETE" ? "primary" : "outline", "sm")}>
          {task.ctaLabel}
        </Link>
      )}
    </li>
  );
}

export function OnboardingChecklist({ tasks }: { tasks: OnboardingTask[] }) {
  return (
    <ul className="space-y-3">
      {tasks.map((t) => (
        <TaskRow key={t.key} task={t} />
      ))}
    </ul>
  );
}
