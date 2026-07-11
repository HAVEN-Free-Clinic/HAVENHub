import { Check } from "lucide-react";
import { trackerStageFor } from "@/modules/recruitment/services/portal-tracker";
import type { ApplicantStatusView } from "@/modules/recruitment/services/portal-status";
import { cx } from "@/platform/ui/cx";

export function ApplicationTracker({ state }: { state: ApplicantStatusView["state"] }) {
  const stage = trackerStageFor(state);
  if (!stage.showTracker) return null;
  return (
    <ol className="mt-4 flex items-start">
      {stage.nodes.map((node, i) => (
        <li key={node.key} className="flex flex-1 flex-col items-center gap-2 text-center">
          <div className="flex w-full items-center">
            <span className={cx("h-0.5 flex-1", i === 0 ? "bg-transparent" : node.status === "upcoming" ? "bg-border" : "bg-brand")} />
            <span
              className={cx(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2",
                node.status === "done" && "border-brand bg-brand text-white",
                node.status === "current" && "border-brand bg-surface ring-4 ring-brand-faint",
                node.status === "upcoming" && "border-border bg-surface",
              )}
            >
              {node.status === "done" && <Check className="h-3 w-3" aria-hidden="true" />}
              {node.status === "current" && <span className="h-2 w-2 rounded-full bg-brand" />}
            </span>
            <span className={cx("h-0.5 flex-1", i === stage.nodes.length - 1 ? "bg-transparent" : node.status === "done" ? "bg-brand" : "bg-border")} />
          </div>
          <span className={cx("text-[11px] leading-tight", node.status === "current" ? "font-semibold text-foreground" : "text-muted-foreground")}>
            {node.label}
          </span>
        </li>
      ))}
    </ol>
  );
}
