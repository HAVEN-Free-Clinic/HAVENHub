import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * A labeled group of fields inside a form. Replaces the divergent hand-rolled
 * fieldset/legend blocks (and the field()/FieldPreview helpers) with one
 * consistent legend style.
 */
export function FormSection({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="m-0 space-y-4 border-0 p-0">
      {title && (
        <legend className="mb-3 p-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </legend>
      )}
      {description && <p className="-mt-2 text-xs text-subtle-foreground">{description}</p>}
      {children}
    </fieldset>
  );
}

/** Standard footer row for form submit/secondary buttons. */
export function FormActions({
  children,
  align = "start",
  className,
}: {
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex items-center gap-3 pt-2",
        align === "end" && "justify-end",
        className,
      )}
    >
      {children}
    </div>
  );
}
