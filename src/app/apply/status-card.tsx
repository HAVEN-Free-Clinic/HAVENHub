import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card, cardClasses } from "@/platform/ui/card";
import { cx } from "@/platform/ui/cx";
import type { ApplicantStatusView } from "@/modules/recruitment/services/portal-status";
import { ApplicationTracker } from "./application-tracker";

export function StatusCard({ app }: { app: ApplicantStatusView }) {
  // Drafts get a compact "continue" row rather than a tracker.
  if (app.state === "DRAFT" && app.canContinue) {
    return (
      <Link
        href={`/apply/${app.slug}`}
        className={cx(cardClasses({ interactive: true }), "group flex items-center justify-between gap-4")}
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-foreground">{app.cycleTitle}</span>
          <span className="block truncate text-xs text-muted-foreground">{app.detail ?? "Continue your application"}</span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-brand-fg">
          Continue
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </span>
      </Link>
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
    </Card>
  );
}
