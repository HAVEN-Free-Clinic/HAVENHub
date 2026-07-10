"use client";
import { useFormStatus } from "react-dom";
import { Button } from "@/platform/ui/button";

type Variant = "primary" | "outline" | "danger" | "ghost";

export function SubmitButton({
  children,
  pendingLabel,
  variant,
  disabled,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  variant?: Variant;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending || disabled}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
