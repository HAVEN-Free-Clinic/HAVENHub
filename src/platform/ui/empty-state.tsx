import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cx } from "./cx";

/**
 * The canonical "there is nothing here" state.
 *
 * Before this primitive the app had 78 hand-rolled empty states drawn in four
 * different colors (`text-subtle-foreground` x36, `text-muted-foreground` x18,
 * `text-foreground-soft` x2, `text-foreground` x2), with only 2 of the 78
 * carrying any vertical padding. The split was not a disagreement about which
 * neutral token is correct -- both muted- and subtle-foreground are deliberately
 * AA-tuned (see globals.css) -- it was two roles collapsed onto one line. An
 * empty state has a primary message and a supporting one, so this primitive
 * gives them distinct tokens rather than picking a single winner:
 *
 * - `title`       -> text-foreground, the sentence the user actually reads
 * - `description` -> text-subtle-foreground, the supporting detail
 *
 * Two variants, because the 78 sites are genuinely two different situations:
 *
 * - `block` (default) fills an empty page body or card body. Centered, padded,
 *   optional leading icon, optional action.
 * - `inline` is the one-line case inside a table cell or a tight section, where
 *   a padded centered block would be wrong. Same look the sites already had,
 *   just on one canonical token.
 *
 * Carries no border or background BY DEFAULT. Most empty states already sit
 * inside a Card, and adding a surface there would double-card them.
 *
 * `bordered` opts into a dashed bounding panel for the case that is not inside
 * a Card: an empty section that needs its own edge to read as a region rather
 * than as loose text on the canvas. Four such panels were hand-rolled in the
 * schedule module with a byte-identical class string. They escaped the sweep
 * that retired the other 78 because `local/no-adhoc-empty-state` only inspects
 * `<p>` elements (eslint.config.mjs), and a div-shaped empty state is
 * structurally invisible to it.
 *
 * The title renders as a `<p>`, not a heading: these appear at unpredictable
 * depths inside pages that already have a PageHeader and SectionHeaders, and a
 * heading here would skip or reverse levels in the document outline.
 *
 * This repo has no tailwind-merge, so a caller className that fights a base
 * class (color, padding, alignment) is emission-order-unreliable. `className`
 * is for outer spacing only -- accept the variant's look or leave the element
 * hand-rolled.
 */

type EmptyStateInlineProps = {
  /** One-line form for table cells and tight sections: no padding, no centering. */
  inline: true;
  /** Outer spacing only. */
  className?: string;
  children: ReactNode;
};

type EmptyStateBlockProps = {
  inline?: false;
  /** Optional leading icon. Reserve it for empty states that fill a page body. */
  icon?: LucideIcon;
  /** The primary message, e.g. "No shifts assigned yet". */
  title: string;
  /** Supporting detail, e.g. what will make rows appear here. */
  description?: ReactNode;
  /** Optional call to action, typically a Button or a link. */
  action?: ReactNode;
  /**
   * Draw a dashed bounding panel. For an empty section that is NOT inside a
   * Card and would otherwise read as loose text on the canvas.
   */
  bordered?: boolean;
  /** Outer spacing only. */
  className?: string;
};

export function EmptyState(props: EmptyStateInlineProps | EmptyStateBlockProps) {
  if (props.inline) {
    return (
      <p className={cx("text-sm text-subtle-foreground", props.className)}>{props.children}</p>
    );
  }

  const { icon: Icon, title, description, action, bordered, className } = props;

  return (
    <div
      className={cx(
        "flex flex-col items-center px-6 py-10 text-center",
        bordered && "rounded-2xl border border-dashed border-border",
        className,
      )}
    >
      {Icon ? <Icon aria-hidden className="mb-3 h-6 w-6 text-subtle-foreground" /> : null}
      <p className="text-base font-semibold text-foreground">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-subtle-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
