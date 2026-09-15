import Link from "next/link";
import {
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Circle,
  ArrowRight,
  ChevronRight,
} from "lucide-react";
import { Badge } from "@/platform/ui/badge";
import { Card } from "@/platform/ui/card";
import { StatusBanner } from "@/platform/ui/status-banner";
import { TextLink } from "@/platform/ui/text-link";
import type { ComplianceStatus } from "@/platform/compliance/rules";
import type { OnboardingTaskState } from "@/platform/compliance/task-state";
import {
  complianceStatusLabel,
  onboardingTaskLabel,
  type LabelAudience,
  type StatusTone as Tone,
} from "@/platform/compliance/labels";

export type Requirement = {
  label: string;
  /** Short, friendly status (never the raw enum). */
  statusLabel: string;
  /** Whether this requirement counts toward clearance. */
  met: boolean;
  tone: Tone;
  /**
   * Where this row takes the reader: the section or page that resolves it.
   * Supplied by the caller, because the answer is page-specific -- on /my-info
   * the HIPAA and EHS sections are further down the same page, while a step with
   * no section here belongs on its /get-started page.
   *
   * Omit it only when there is genuinely nowhere to send someone. Rows without a
   * destination are the reason members click them and nothing happens: the
   * checklist reads as a list of things to go do, so an inert row is a dead end
   * (PostHog inbox 01a036e2 -- 51 members clicked "EHS training" here).
   */
  href?: string;
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

/**
 * Whether a cert status counts toward clearance. Separate from the label: this
 * is gating, the label is wording, and only the wording varies by audience.
 */
function certMet(status: ComplianceStatus): boolean {
  return status === "COMPLIANT" || status === "EXPIRING_SOON";
}

/**
 * `audience` is the READER, not the subject. /my-info is a member reading their
 * own clearance; /volunteers/compliance/[personId] is a compliance manager
 * reading someone else's, and takes "staff" so it matches the roster they
 * clicked in from.
 */
export function certRequirement(
  status: ComplianceStatus,
  audience: LabelAudience,
  href?: string,
): Requirement {
  const { label, tone } = complianceStatusLabel(status, audience);
  return { label: "HIPAA certificate", href, statusLabel: label, met: certMet(status), tone };
}

export function taskRequirement(
  label: string,
  state: OnboardingTaskState,
  audience: LabelAudience,
  href?: string,
): Requirement {
  const display = onboardingTaskLabel(state, { audience, actionable: !!href });
  return {
    label,
    href,
    statusLabel: display.label,
    met: state === "COMPLETE" || state === "NOT_REQUIRED",
    tone: display.tone,
  };
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
  finishHref,
}: {
  requirements: Requirement[];
  cleared: boolean;
  termName?: string | null;
  /** Where the "Finish onboarding" CTA should link, or null/undefined to hide it.
   *  Callers pass this only when there is a page the viewer can act on: an already
   *  onboarded member (only coordinator-recorded items left) or a director viewing
   *  someone else's clearance both get no CTA, since /get-started would dead-end. */
  finishHref?: string | null;
}) {
  const forTerm = termName ? ` for ${termName}` : "";

  return (
    <Card pad={false} className="overflow-hidden">
      {/* The same banner /training shows, on the shared scale. This one had
          text-[17px] over text-[13px] and a rounded-[13px] chip: a pixel off on
          both lines and on the radius, which reads as a rendering bug rather
          than a decision. Neither number is on any scale this app has.

          surface="attached" because the checklist below is the same object:
          a second border between the two would read as two cards. */}
      {cleared ? (
        <StatusBanner
          surface="attached"
          tone="success"
          icon={ShieldCheck}
          eyebrow="Cleared"
          title={<>You&apos;re fully cleared{forTerm}</>}
          description="Your onboarding and compliance items are all complete."
        />
      ) : (
        <StatusBanner
          surface="attached"
          tone="warning"
          icon={AlertTriangle}
          eyebrow="Not yet cleared"
          title={<>A few steps left{forTerm}</>}
          description="Finish the unchecked items below to be fully cleared."
        />
      )}

      {/* Requirements checklist. A row with a href is a link across its whole
          width, badge included: the banner above tells members to go finish
          these, so they click the row itself -- the label, the status badge,
          anywhere -- and an inert row swallows that click (see Requirement.href). */}
      <ul className="divide-y divide-border-subtle">
        {requirements.map((req) => (
          <li key={req.label}>
            {req.href ? (
              <Link
                href={req.href}
                className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
              >
                <RowIcon tone={req.tone} met={req.met} />
                <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{req.label}</span>
                <Badge tone={req.tone}>{req.statusLabel}</Badge>
                <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Link>
            ) : (
              <div className="flex items-center gap-3 px-5 py-3.5">
                <RowIcon tone={req.tone} met={req.met} />
                <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{req.label}</span>
                <Badge tone={req.tone}>{req.statusLabel}</Badge>
              </div>
            )}
          </li>
        ))}
      </ul>

      {/* Next-step CTA. Only shown when the caller supplies a href the viewer can
          actually act on (see finishHref) -- never a link that redirects straight
          back to the dashboard. */}
      {!cleared && finishHref && (
        <div className="border-t border-border-subtle px-5 py-3.5">
          <TextLink
            href={finishHref}
            size="sm"
            className="inline-flex items-center gap-1.5 font-semibold"
          >
            Finish onboarding
            <ArrowRight aria-hidden className="h-4 w-4" />
          </TextLink>
        </div>
      )}
    </Card>
  );
}
