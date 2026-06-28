import Link from "next/link";
import { Lock, ArrowLeft } from "lucide-react";
import { buttonClasses } from "@/platform/ui/button";

/**
 * Friendly landing for a denied permission check. requirePermission redirects
 * here (instead of silently bouncing to the hub) so a partial-permission member
 * who reaches a gated URL gets an explanation rather than a confusing dead end.
 *
 * Lives in the (app) group so it keeps the toolbar/nav -- the member can step
 * straight to a module they CAN open. Gated only by requirePersonSession (via
 * the group layout); it must never be permission-gated or the redirect loops.
 */
export default function NoAccessPage() {
  return (
    <div className="mx-auto max-w-lg py-10 text-center">
      <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-amber-50 text-warning">
        <Lock aria-hidden className="h-7 w-7" />
      </span>
      <h1 className="mt-5 text-2xl font-bold tracking-tight text-foreground">
        You don&apos;t have access to that page
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-foreground-soft">
        Your current role doesn&apos;t include this page. If you think you should
        have access, ask a clinic admin to update your permissions.
      </p>
      <div className="mt-7 flex justify-center">
        <Link href="/" className={buttonClasses("primary", "md", "gap-2")}>
          <ArrowLeft aria-hidden className="h-4 w-4" />
          Back to hub
        </Link>
      </div>
    </div>
  );
}
