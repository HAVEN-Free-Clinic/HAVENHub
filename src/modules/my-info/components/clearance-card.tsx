import Link from "next/link";
import {
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Circle,
  ArrowRight,
} from "lucide-react";
import { Badge } from "@/platform/ui/badge";
import { Card } from "@/platform/ui/card";
import type { ComplianceStatus } from "@/platform/compliance/rules";

type Tone = "success" | "warning" | "critical" | "default";

/** Mirrors OnboardingTaskState from the onboarding engine; redeclared locally to
 *  avoid a cross-module import (modules must go through platform). */
type TaskState = "COMPLETE" | "IN_PROGRESS" | "INCOMPLETE" | "NOT_REQUIRED";

export type Requirement = {
  label: string;
  /** Short, friendly status (never the raw enum). */
  statusLabel: string;
  /** Whether this requirement counts toward clearance. */
  met: boolean;
  tone: Tone;
};

const rowIconClasses: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  critical: "text-critical",
  default: "text-subtle-foreground",
};

function RowIcon({ tone, met }: { tone: Tone; met: boolean }) {
  const cls = `h-[18px] w-[18px] shrink-0 ${rowIconClasses[tone]}`;
  if (met) return <CheckCircle2 aria-hidden className={cls} />;
  if (tone === "critical") return <XCircle aria-hidden className={cls} />;
  if (tone === "warning") return <AlertTriangle aria-hidden className={cls} />;
  return <Circle aria-hidden className={cls} />;
}

export function certRequirement(status: ComplianceStatus): Requirement {
  switch (status) {
    case "COMPLIANT":
      return { label: "HIPAA certificate", statusLabel: "Valid", met: true, tone: "success" };
    case "EXPIRING_SOON":
      return { label: "HIPAA certificate", statusLabel: "Expiring soon", met: true, tone: "warning" };
    case "EXPIRED":
      return { label: "HIPAA certificate", statusLabel: "Expired", met: false, tone: "critical" };
    case "UNKNOWN_DATE":
      return { label: "HIPAA certificate", statusLabel: "Needs completion date", met: false, tone: "warning" };
    case "PENDING_VERIFICATION":
      return { label: "HIPAA certificate", statusLabel: "Awaiting verification", met: false, tone: "warning" };
    case "NO_CERTIFICATE":
      return { label: "HIPAA certificate", statusLabel: "Not uploaded", met: false, tone: "default" };
  }
}

export function taskRequirement(label: string, state: TaskState): Requirement {
  switch (state) {
    case "COMPLETE":
      return { label, statusLabel: "Complete", met: true, tone: "success" };
    case "IN_PROGRESS":
      return { label, statusLabel: "In progress", met: false, tone: "warning" };
    case "INCOMPLETE":
      return { label, statusLabel: "Not started", met: false, tone: "warning" };
    case "NOT_REQUIRED":
      return { label, statusLabel: "Not required", met: true, tone: "default" };
  }
}

/**
 * Member clearance summary: a status banner driven by the cleared flag, then
 * a checklist of requirements with friendly labels and semantic badges.
 * Frames missing items as next steps, not failures.
 */
export function ClearanceCard({
  requirements,
  cleared,
  termName,
}: {
  requirements: Requirement[];
  cleared: boolean;
  termName?: string | null;
}) {
  const forTerm = termName ? ` for ${termName}` : "";

  return (
    <Card pad={false} className="overflow-hidden">
      {/* Status banner */}
      {cleared ? (
        <div className="flex items-center gap-4 border-b border-border bg-muted px-5 py-4">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[13px] bg-success text-white">
            <ShieldCheck aria-hidden className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wider text-success">Cleared</p>
            <p className="mt-0.5 text-[17px] font-bold tracking-tight text-foreground">
              You&apos;re fully cleared{forTerm}
            </p>
            <p className="mt-0.5 text-[13px] leading-snug text-foreground-soft">
              Your onboarding and compliance items are all complete.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-4 border-b border-border bg-muted px-5 py-4">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[13px] bg-warning text-white">
            <AlertTriangle aria-hidden className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wider text-warning">Not yet cleared</p>
            <p className="mt-0.5 text-[17px] font-bold tracking-tight text-foreground">
              A few steps left{forTerm}
            </p>
            <p className="mt-0.5 text-[13px] leading-snug text-foreground-soft">
              Finish the unchecked items below to be fully cleared.
            </p>
          </div>
        </div>
      )}

      {/* Requirements checklist */}
      <ul className="divide-y divide-border-subtle">
        {requirements.map((req) => (
          <li key={req.label} className="flex items-center gap-3 px-5 py-3.5">
            <RowIcon tone={req.tone} met={req.met} />
            <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{req.label}</span>
            <Badge tone={req.tone}>{req.statusLabel}</Badge>
          </li>
        ))}
      </ul>

      {/* Next-step CTA */}
      {!cleared && (
        <div className="border-t border-border-subtle px-5 py-3.5">
          <Link
            href="/get-started"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-fg hover:text-brand-hover"
          >
            Finish onboarding
            <ArrowRight aria-hidden className="h-4 w-4" />
          </Link>
        </div>
      )}
    </Card>
  );
}
