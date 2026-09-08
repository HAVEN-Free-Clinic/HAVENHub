import type { ReactNode } from "react";
import Link from "next/link";
import { NavForm } from "./nav-form";
import { Button, buttonClasses } from "./button";
import { Field } from "./input";
import { FORM_ROW, ROW_WIDTH, type RowWidth } from "./form";
import { cx } from "./cx";

/**
 * The filter row above a list.
 *
 * `NavForm` already ships the behaviour (soft-nav GET submit, empty params
 * dropped, pending reported to ListPending) but no layout, so eleven list pages
 * each invented their own row on top of it and they had split into two camps: the
 * admin pages labelled their controls with `aria-label` only, submitted through an
 * outline button and offered no way to clear; the volunteers and incidents pages
 * used visible `Field` labels, a brand-filled primary button, and a Clear link.
 * Widths were picked per page from six different values; they now come from
 * the shared `ROW_WIDTH` table in form.tsx.
 *
 * The settled shape, and why:
 *
 *  - **Visible labels.** An `aria-label`-only select tells a screen reader what it
 *    filters and a sighted user nothing: "All statuses" alone does not say which
 *    status. `FilterField` wraps every control in `Field`, so the label is real.
 *  - **An outline submit.** Filtering refines what is already on screen; it is not
 *    the page's primary action. Four pages rendered it brand-filled, which is what
 *    teaches the eye to stop reading brand fill as "do this".
 *  - **Clear whenever a filter is active.** Pass `clearHref` only in that case; a
 *    list with no way back to the unfiltered view reads as data loss.
 *  - **A plain Button, not SubmitButton.** `NavForm` preventDefaults and pushes, so
 *    `useFormStatus` never fires inside it (see its own doc comment). A
 *    `SubmitButton` here has a `pendingLabel` that can never render. The list dims
 *    through `ListPending` instead, which is what `NavForm` reports to.
 */
export function FilterBar({
  action,
  clearHref,
  submitLabel = "Filter",
  className,
  children,
}: {
  /** Target path. Omit to submit to the current pathname. */
  action?: string;
  /**
   * Where "Clear" goes, normally this list's own path with no query. Pass it
   * ONLY when a filter is currently applied, so the link never offers to clear
   * an already-clean list.
   */
  clearHref?: string;
  /** Defaults to "Filter". Override only where the verb is genuinely different. */
  submitLabel?: string;
  /** Outer spacing only. The row's own flex classes are not overridable. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <NavForm action={action} className={cx(FORM_ROW, className)}>
      {children}
      <Button type="submit" variant="outline" size="sm">
        {submitLabel}
      </Button>
      {/* A Link, not a Button: clearing is a navigation to the unfiltered list,
          and Button renders a <button> with no href. buttonClasses is the house
          helper for exactly this (see volunteers/directory, which already did
          it this way). */}
      {clearHref && (
        <Link href={clearHref} className={buttonClasses("ghost", "sm")}>
          Clear
        </Link>
      )}
    </NavForm>
  );
}

/** One labelled control in a FilterBar. Widths come from the shared `ROW_WIDTH`
 * table in form.tsx, so a Department select in a filter row is the same width as
 * a Department select in the write form above it. */
export function FilterField({
  label,
  width = "control",
  children,
}: {
  label: string;
  width?: RowWidth;
  children: ReactNode;
}) {
  return (
    <div className={ROW_WIDTH[width]}>
      <Field label={label}>{children}</Field>
    </div>
  );
}
