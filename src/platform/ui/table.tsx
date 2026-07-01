import type { ComponentProps } from "react";
import { cardClasses } from "./card";
import { cx } from "./cx";

/** Scrollable container card wrapping the table element. */
export function Table({ className, ...rest }: ComponentProps<"table">) {
  return (
    <div className={cx(cardClasses({ pad: false }), "overflow-x-auto")}>
      <table
        {...rest}
        className={cx("w-full text-sm", className)}
      />
    </div>
  );
}

export function THead({ className, ...rest }: ComponentProps<"thead">) {
  return <thead {...rest} className={cx("bg-muted", className)} />;
}

export function TR({ className, ...rest }: ComponentProps<"tr">) {
  return (
    <tr {...rest} className={cx("border-t border-border-subtle", className)} />
  );
}

export function TH({ className, ...rest }: ComponentProps<"th">) {
  return (
    <th
      {...rest}
      className={cx(
        "px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-subtle-foreground",
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
