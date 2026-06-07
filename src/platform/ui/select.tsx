import type { ComponentProps } from "react";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

const selectBase =
  "rounded-md border border-slate-300 px-3 py-2 text-sm w-full outline-none " +
  "focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15 " +
  "disabled:opacity-50 disabled:bg-slate-50 bg-white";

export function Select({
  className,
  ...rest
}: ComponentProps<"select">) {
  return <select {...rest} className={cx(selectBase, className)} />;
}
