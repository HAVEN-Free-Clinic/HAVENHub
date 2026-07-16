import { Check } from "lucide-react";
import { cx } from "@/platform/ui/cx";

export function WizardProgress({
  steps,
  current,
  onJump,
}: {
  steps: { id: string; title: string }[];
  current: number;
  onJump: (index: number) => void;
}) {
  const total = steps.length;
  return (
    <>
      {/* Mobile: compact header */}
      <div className="md:hidden">
        <p className="text-xs font-semibold uppercase tracking-wider text-brand-fg">
          Step {current + 1} of {total}
        </p>
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-brand transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${((current + 1) / total) * 100}%` }}
          />
        </div>
      </div>

      {/* Desktop: vertical rail */}
      <nav aria-label="Application progress" className="hidden md:block">
        <ol className="relative space-y-1">
          {steps.map((s, i) => {
            const done = i < current;
            const isCurrent = i === current;
            const label = (
              <span className="flex items-center gap-3 py-1.5">
                <span
                  className={cx(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold",
                    done && "border-brand bg-brand text-white",
                    isCurrent && "border-brand bg-surface text-brand-fg ring-4 ring-brand-faint",
                    !done && !isCurrent && "border-border bg-surface text-muted-foreground",
                  )}
                >
                  {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : i + 1}
                </span>
                <span
                  className={cx(
                    "text-sm",
                    isCurrent ? "font-semibold text-foreground" : done ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {s.title}
                </span>
              </span>
            );
            return (
              <li key={s.id}>
                {done ? (
                  // A full-width rail step needs custom layout, so it is a raw button, not
                  // the Button primitive. The repo's no-restricted-syntax rule flags styled
                  // raw controls; keep className on the button line and disable it there.
                  // eslint-disable-next-line no-restricted-syntax -- rail step needs custom full-width layout, not a Button primitive
                  <button type="button" onClick={() => onJump(i)} className="w-full rounded-lg text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
                    {label}
                  </button>
                ) : (
                  <div aria-current={isCurrent ? "step" : undefined}>{label}</div>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </>
  );
}
