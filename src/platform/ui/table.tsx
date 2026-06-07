import type { ComponentProps } from "react";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** Scrollable container card wrapping the table element. */
export function Table({ className, ...rest }: ComponentProps<"table">) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
      <table
        {...rest}
        className={cx("w-full text-sm", className)}
      />
    </div>
  );
}

export function THead({ className, ...rest }: ComponentProps<"thead">) {
  return <thead {...rest} className={cx("bg-slate-50", className)} />;
}

export function TR({ className, ...rest }: ComponentProps<"tr">) {
  return (
    <tr {...rest} className={cx("border-t border-slate-100", className)} />
  );
}

export function TH({ className, ...rest }: ComponentProps<"th">) {
  return (
    <th
      {...rest}
      className={cx(
        "px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-slate-400",
        className,
      )}
    />
  );
}

export function TD({ className, ...rest }: ComponentProps<"td">) {
  return (
    <td {...rest} className={cx("px-3 py-2.5", className)} />
  );
}
