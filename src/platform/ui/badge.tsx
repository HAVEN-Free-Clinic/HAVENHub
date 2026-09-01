import type { ComponentProps } from "react";
import { cx } from "./cx";

type Tone = "default" | "brand" | "success" | "warning" | "critical";

/**
 * Tone → label color. The chip is a bare hairline outline and the tone lives in the
 * word itself.
 *
 * This replaced a leading colored dot on a bordered, muted-filled chip (PR #149,
 * which had in turn replaced pastel tinted pills). The dot read as vibe-coded for a
 * concrete reason worth keeping written down: it was decoration carrying no
 * information. The label already names the status, so the dot duplicated it; and on
 * the count badges (`<Badge tone="warning">{n}</Badge>`) there was no status to
 * duplicate at all -- a colored dot next to a bare "3" disambiguates nothing, it is
 * just texture. Three chrome layers (border + fill + dot) on two characters.
 *
 * Folding the tone into the label leaves one decoration layer instead of three, and
 * makes the color do work: it modifies the word it is attached to.
 *
 * These are the *-foreground text variants, NOT the vivid --color-success/warning/
 * critical fills. The vivid ones are tuned for 3:1 non-text (icons, dots) and fail
 * WCAG AA as 11px text. See globals.css and theme-contrast.test.ts.
 */
export const BADGE_TONE_CLASSES: Record<Tone, string> = {
  default: "text-muted-foreground",
  brand: "text-brand-fg",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  critical: "text-critical-foreground",
};

type BadgeProps = ComponentProps<"span"> & {
  tone?: Tone;
  /**
   * Render as a numeric count: centered, with a min-width so 1 and 3 and 12 all
   * produce the same chip width instead of jittering as the number changes.
   *
   * Not inferred from `typeof children === "number"`. Plenty of call sites pass a
   * quantity *with* a unit ("3 shadows", "12 available"), which is a label and wants
   * normal left-aligned text; and a caller may hold a count in a string. Making it
   * explicit keeps the two cases from guessing at each other.
   */
  count?: boolean;
};

export function Badge({ tone = "default", count = false, className, children, ...rest }: BadgeProps) {
  return (
    <span
      {...rest}
      className={cx(
        "inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] font-semibold",
        // Tabular figures on every badge, not just counts: labels like "3 shadows"
        // and "Cycle 2" also line up in table columns, and proportional digits in a
        // 600-weight face at 11px are what make a column of chips look hand-placed.
        "tabular-nums",
        count && "min-w-[1.375rem] justify-center px-1.5",
        BADGE_TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
