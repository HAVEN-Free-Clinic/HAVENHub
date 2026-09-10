import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cardClasses } from "./card";
import { cx } from "./cx";

/**
 * The "where do you stand" banner: an icon chip, a tone-coloured eyebrow, a
 * headline, a sentence, and sometimes a pill on the right.
 *
 * Two pages a member actually checks drew it, and they were a pixel apart on
 * both lines:
 *
 *   /training   text-lg / text-sm    rounded-xl chip
 *   /my-info    text-[17px] / text-[13px]  rounded-[13px] chip
 *
 * Close enough to look like a rendering bug rather than a decision, and far
 * enough that the two never quite matched. /training's scale won because it is
 * Tailwind tokens rather than arbitrary pixels: 17px and 13px are on no scale
 * this app has, so nothing else could ever be asked to match them.
 *
 * ## Tones
 *
 * The chip is the vivid token on white; the eyebrow is the AA-tuned
 * `*-foreground` pair. That split is the house rule and it is a contrast
 * requirement, not a preference: the vivid tokens clear 3:1 and are for icons
 * and fills, and text needs the `-foreground` variant. Mapping a tone to the
 * wrong one is a legibility bug rather than a colour one.
 *
 * ## Surfaces
 *
 * `card` stands alone with its own border and radius. `attached` is the strip
 * across the top of a Card that owns the content below it, which is what
 * /my-info's clearance card needs: the banner and its checklist are one object
 * and a second border between them reads as two.
 *
 * `className` is outer spacing only. This repo has no tailwind-merge, so a
 * caller class landing on the same property as one of these is decided by
 * emission order rather than by who wrote it last.
 */
type StatusBannerTone = "success" | "warning" | "critical" | "neutral";

const CHIP: Record<StatusBannerTone, string> = {
  success: "bg-success text-white",
  warning: "bg-warning text-white",
  critical: "bg-critical text-white",
  neutral: "bg-muted-strong text-muted-foreground",
};

const EYEBROW: Record<StatusBannerTone, string> = {
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  critical: "text-critical-foreground",
  neutral: "text-muted-foreground",
};

export function StatusBanner({
  tone,
  icon: Icon,
  eyebrow,
  title,
  description,
  trailing,
  surface = "card",
  className,
}: {
  tone: StatusBannerTone;
  icon: LucideIcon;
  /** The state, in two or three words. Coloured by tone. */
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  /** A pill on the trailing edge: a completion date, "Action needed". */
  trailing?: ReactNode;
  surface?: "card" | "attached";
  /** Outer spacing only. */
  className?: string;
}) {
  return (
    <div
      className={cx(
        surface === "card"
          ? cx(cardClasses({ pad: false }), "flex flex-wrap items-center gap-4 px-5 py-5")
          : "flex flex-wrap items-center gap-4 border-b border-border bg-muted px-5 py-4",
        className,
      )}
    >
      <span className={cx("grid h-12 w-12 shrink-0 place-items-center rounded-xl", CHIP[tone])}>
        <Icon aria-hidden className="h-6 w-6" />
      </span>
      <div className="min-w-0 flex-1">
        <p className={cx("text-xs font-bold uppercase tracking-wider", EYEBROW[tone])}>{eyebrow}</p>
        <p className="mt-0.5 text-lg font-bold tracking-tight text-foreground">{title}</p>
        {description && (
          <p className="mt-1 text-sm leading-snug text-foreground-soft">{description}</p>
        )}
      </div>
      {trailing && (
        <span className="shrink-0 basis-full sm:basis-auto whitespace-nowrap rounded-full border border-border bg-muted px-3 py-1.5 text-xs font-semibold text-foreground-soft">
          {trailing}
        </span>
      )}
    </div>
  );
}
