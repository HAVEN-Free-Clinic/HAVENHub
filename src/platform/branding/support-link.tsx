import type { ReactNode } from "react";

/**
 * Shared so the Messenger-aware variant (platform/intercom/messenger-support-link)
 * is visually identical to this one. The two render the same anchor and differ
 * only in what a click does, so they must not drift apart in styling.
 */
export const supportLinkClasses =
  "font-medium text-brand-fg underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

/**
 * Renders `children` as a mailto link to the configured support email, or as
 * plain text when no support email is set. Centralizes the link styling and the
 * blank-handling shared by the signed-out pages (sign-in, 404, welcome).
 */
export function SupportLink({ email, children }: { email: string; children: ReactNode }) {
  if (!email) return <>{children}</>;
  return (
    <a href={`mailto:${email}`} className={supportLinkClasses}>
      {children}
    </a>
  );
}
