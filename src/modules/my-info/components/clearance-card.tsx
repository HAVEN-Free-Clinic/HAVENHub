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
import type {
  ComplianceStatus,
  OverallClearance,
  TrainingState,
} from "@/platform/compliance/rules";

type Tone = "success" | "warning" | "critical" | "default";

type Requirement = {
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

function certRequirement(status: ComplianceStatus): Requirement {
  switch (status) {
    case "COMPLIANT":
      return { label: "HIPAA certificate", statusLabel: "Valid", met: true, tone: "success" };
    case "EXPIRING_SOON":
      return { label: "HIPAA certificate", statusLabel: "Expiring soon", met: true, tone: "warning" };
    case "EXPIRED":
      return { label: "HIPAA certificate", statusLabel: "Expired", met: false, tone: "critical" };
    case "UNKNOWN_DATE":
      return { label: "HIPAA certificate", statusLabel: "Needs completion date", met: false, tone: "warning" };
    case "NO_CERTIFICATE":
      return { label: "HIPAA certificate", statusLabel: "Not uploaded", met: false, tone: "default" };
  }
}

function trainingRequirement(state: TrainingState): Requirement {
  return state === "COMPLETE"
    ? { label: "Volunteer training", statusLabel: "Complete", met: true, tone: "success" }
    : { label: "Volunteer training", statusLabel: "Not complete", met: false, tone: "warning" };
}

/**
 * Volunteer clearance summary: a status banner driven by overall clearance, then
 * a checklist of the two requirements (HIPAA certificate + training) with friendly
 * labels and semantic badges. Frames missing items as next steps, not failures.
 */
export function ClearanceCard({
  clearance,
  certStatus,
  trainingState,
  termName,
}: {
  clearance: OverallClearance;
  certStatus: ComplianceStatus;
  trainingState: TrainingState;
  termName?: string | null;
}) {
  const cert = certRequirement(certStatus);
  const training = trainingRequirement(trainingState);
  const requirements = [cert, training];
  const cleared = clearance === "CLEARED";
  const forTerm = termName ? ` for ${termName}` : "";

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
      {/* Status banner */}
      {cleared ? (
        <div className="flex items-center gap-4 border-b border-green-200 bg-green-50 px-5 py-4">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[13px] bg-success text-white">
            <ShieldCheck aria-hidden className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wider text-success">Cleared</p>
            <p className="mt-0.5 text-[17px] font-bold tracking-tight text-slate-800">
              You&apos;re cleared to volunteer{forTerm}
            </p>
            <p className="mt-0.5 text-[13px] leading-snug text-slate-700">
              Your HIPAA certificate and training are on file, so you can be scheduled for shifts.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-4 border-b border-amber-200 bg-amber-50 px-5 py-4">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[13px] border border-amber-300 bg-white text-warning">
            <AlertTriangle aria-hidden className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wider text-warning">Not yet cleared</p>
            <p className="mt-0.5 text-[17px] font-bold tracking-tight text-slate-800">
              A few steps left{forTerm}
            </p>
            <p className="mt-0.5 text-[13px] leading-snug text-slate-700">
              Finish the unchecked items below to be cleared for shifts.
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
      {!training.met && (
        <div className="border-t border-border-subtle px-5 py-3.5">
          <Link
            href="/training"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-fg hover:text-brand-hover"
          >
            Complete your training
            <ArrowRight aria-hidden className="h-4 w-4" />
          </Link>
        </div>
      )}
    </div>
  );
}
