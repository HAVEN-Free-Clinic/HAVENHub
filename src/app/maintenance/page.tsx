import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Wrench } from "lucide-react";
import { auth } from "@/platform/auth/auth";
import { getSetting } from "@/platform/settings/service";
import { getSupportContact } from "@/platform/branding/support";
import { SupportLink } from "@/platform/branding/support-link";
import { HavenLogo } from "@/platform/ui/haven-logo";
import { CopyrightNotice } from "@/platform/ui/app-footer";
import { buildPageMetadata } from "@/platform/branding/metadata";
import {
  isMaintenanceEnabled,
  getMaintenanceNotice,
  holdsMaintenanceBypass,
} from "@/platform/maintenance/status";

export function generateMetadata() {
  return buildPageMetadata({ title: "Down for maintenance" });
}

const DEFAULT_MESSAGE =
  "We have taken the hub offline for a short while to work on it. Nothing you have already submitted is affected.";

/**
 * The page every blocked request lands on while maintenance mode is on. It sits
 * outside the (app) group on purpose: no toolbar, no session requirement, and
 * no onboarding gate, so it renders for a signed-out visitor and a signed-in
 * member alike.
 *
 * It is also the page a bypass holder sees if they follow a stale link during a
 * window, so it tells them they are exempt and offers the way back in, rather
 * than implying the switch is stuck. "Bypass holder" means anyone who can reach
 * /admin/settings (admin.manage_settings, which "*" satisfies), deliberately the
 * same audience that can turn the switch on -- see platform/maintenance/status.ts.
 */
export default async function MaintenancePage() {
  // Not a dead end once the window closes: anyone still sitting on this page (or
  // holding a bookmark to it) is sent back to the hub the moment the switch is
  // off. The proxy exempts /maintenance, so nothing redirects them here again.
  if (!(await isMaintenanceEnabled())) redirect("/");

  const [{ message, until }, appName, support, session] = await Promise.all([
    getMaintenanceNotice(),
    getSetting<string>("branding.appName"),
    getSupportContact(),
    auth(),
  ]);
  const canBypass = session?.personId ? await holdsMaintenanceBypass(session.personId) : false;

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-6 overflow-hidden p-6">
      {/* Same brand backdrop as the sign-in screen: this is the other page a
          logged-out visitor can be shown, and the two should feel like one site. */}
      <Image
        src="/brand/login-building.webp"
        alt=""
        aria-hidden="true"
        fill
        priority
        sizes="100vw"
        className="object-cover object-center"
      />
      <div aria-hidden="true" className="absolute inset-0 bg-brand/30" />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-b from-brand-deep/55 via-brand/10 to-brand-deep/60"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-br from-brand-deep/45 via-transparent to-transparent"
      />

      <div className="glass-panel relative z-10 w-full max-w-md rounded-2xl p-8 shadow-xl">
        <HavenLogo className="mx-auto h-8 text-brand-fg" />

        <div className="mt-6 flex justify-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand/10 text-brand-fg">
            <Wrench className="h-6 w-6" aria-hidden />
          </span>
        </div>

        <h1 className="mt-5 text-center text-2xl font-bold tracking-tight text-foreground">
          {appName} is down for maintenance
        </h1>
        <p className="mt-3 text-center text-sm text-foreground-soft">{message || DEFAULT_MESSAGE}</p>

        {until && (
          <p className="mt-4 text-center text-sm font-medium text-foreground">
            Expected back: {until}
          </p>
        )}

        {canBypass && (
          <div className="mt-6 rounded-xl border border-border-subtle bg-surface/60 px-4 py-3 text-sm text-foreground-soft">
            <p>
              Maintenance mode does not apply to you, because you can turn it off. Everyone else sees
              this page until you do.
            </p>
            <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
              <Link href="/" className="font-medium text-brand-fg underline underline-offset-2">
                Continue to the hub
              </Link>
              <Link
                href="/admin/settings"
                className="font-medium text-brand-fg underline underline-offset-2"
              >
                Turn maintenance off
              </Link>
            </p>
          </div>
        )}

        {support.email && (
          <p className="mt-6 text-center text-sm text-muted-foreground">
            Need something urgently?{" "}
            <SupportLink email={support.email}>{support.label}</SupportLink>
          </p>
        )}
      </div>

      <CopyrightNotice tone="onBrand" className="relative z-10 text-center" />
    </div>
  );
}
