import type { ComponentProps } from "react";
import { cx } from "./cx";

const selectBase =
  "rounded-lg border border-border-strong px-3 py-2 text-sm w-full outline-none " +
  "focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15 " +
  "disabled:opacity-50 disabled:bg-muted bg-surface";

export function Select({
  className,
  ...rest
}: ComponentProps<"select">) {
  return <select {...rest} className={cx(selectBase, className)} />;
}
