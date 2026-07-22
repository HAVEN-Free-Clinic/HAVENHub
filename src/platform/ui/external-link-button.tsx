import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { buttonClasses } from "./button";

/**
 * An external link styled as a button. <Button> renders a <button> only, so
 * external CTAs are anchors; this centralizes the app's external-link
 * convention (target=_blank + rel + sr-only "opens in a new tab") so every one
 * looks and behaves the same.
 */
export function ExternalLinkButton({
  href,
  children,
  variant = "outline",
  size = "sm",
  className,
}: {
  href: string;
  children: ReactNode;
  variant?: Parameters<typeof buttonClasses>[0];
  size?: Parameters<typeof buttonClasses>[1];
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={buttonClasses(variant, size, className)}
    >
      {children}
      <ExternalLink aria-hidden className="ml-1.5 h-3.5 w-3.5 shrink-0" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
