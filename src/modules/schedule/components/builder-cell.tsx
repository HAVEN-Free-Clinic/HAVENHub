"use client";

import { useFormStatus } from "react-dom";
import { buttonClasses } from "@/platform/ui/button";

// ---------------------------------------------------------------------------
// BuilderCell
// ---------------------------------------------------------------------------
// A tiny client island: a <form> wrapping a submit button that posts a server
// action with hidden inputs. useFormStatus disables the button while pending.

type Variant = "assign" | "tag" | "remove";

type Props = {
  action: (fd: FormData) => Promise<void>;
  hidden: Record<string, string>;
  label: string;
  pressed?: boolean;
  variant?: Variant;
};

function SubmitButton({
  label,
  pressed,
  variant,
}: {
  label: string;
  pressed?: boolean;
  variant?: Variant;
}) {
  const { pending } = useFormStatus();

  const cls =
    variant === "tag"
      ? buttonClasses(
          pressed ? "primary" : "outline",
          "sm",
          "text-xs px-2 py-0.5",
        )
      : variant === "remove"
        ? buttonClasses("danger", "sm")
        : buttonClasses("outline", "sm");

  return (
    <button type="submit" disabled={pending} className={cls} aria-pressed={pressed}>
      {pending ? "..." : label}
    </button>
  );
}

export function BuilderCell({ action, hidden, label, pressed, variant }: Props) {
  return (
    <form action={action} className="inline">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <SubmitButton label={label} pressed={pressed} variant={variant} />
    </form>
  );
}
