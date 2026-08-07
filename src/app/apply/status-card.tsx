import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card, cardClasses } from "@/platform/ui/card";
import { cx } from "@/platform/ui/cx";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import type { ApplicantStatusView } from "@/modules/recruitment/services/portal-status";
import { ApplicationTracker } from "./application-tracker";
import { withdrawApplicationAction, discardDraftAction } from "./portal-actions";

/** Copy for each control, keyed by the server-computed withdraw kind. */
const CONTROL = {
  discard_draft: { label: "Discard draft", confirm: "Discard? This deletes your answers and any files." },
  withdraw: { label: "Withdraw application", confirm: "Withdraw? We will stop considering you this cycle." },
  decline_offer: { label: "Decline offer", confirm: "Decline this offer?" },
} as const;

/** The two-click destructive control, rendered only when the server said so.
 *  Eligibility lives in portal-status; this component never decides it. */
function WithdrawControl({ app }: { app: ApplicantStatusView }) {
  if (!app.withdraw) return null;
  const { label, confirm } = CONTROL[app.withdraw.kind];
  const action = app.withdraw.kind === "discard_draft" ? discardDraftAction : withdrawApplicationAction;
  return (
    <form action={action.bind(null, app.slug)} className="mt-3 flex justify-end border-t border-border-subtle pt-3">
      <ConfirmButton label={label} confirmLabel={confirm} size="sm" />
    </form>
  );
}

export function StatusCard({ app }: { app: ApplicantStatusView }) {
  // Drafts get a compact "continue" row rather than a tracker. The row is NOT a
  // whole-card link: a button nested inside an anchor is invalid markup and
  // unreliable for keyboard users, so the link is scoped to its own cue.
  if (app.state === "DRAFT" && app.canContinue) {
    return (
      <Card className="space-y-1">
        <div className="flex items-center justify-between gap-4">
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-foreground">{app.cycleTitle}</span>
            <span className="block truncate text-xs text-muted-foreground">{app.detail ?? "Continue your application"}</span>
          </span>
          <Link
            href={`/apply/${app.slug}`}
            className={cx(cardClasses({ interactive: true, pad: false }), "group inline-flex shrink-0 items-center gap-1 px-3 py-1.5 text-sm font-medium text-brand-fg")}
          >
            Continue
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
        </div>
        <WithdrawControl app={app} />
      </Card>
    );
  }

  return (
    <Card className="space-y-1">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{app.cycleTitle}</p>
          {app.detail && <p className="mt-0.5 text-xs text-muted-foreground">{app.detail}</p>}
        </div>
        <span className="shrink-0 rounded-full bg-brand-faint px-3 py-1 text-xs font-semibold text-brand-fg">{app.headline}</span>
      </div>
      <ApplicationTracker state={app.state} />
      <WithdrawControl app={app} />
    </Card>
  );
}
