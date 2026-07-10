import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { prisma } from "@/platform/db";
import { getApplicantIdentity } from "@/modules/recruitment/services/portal-auth";
import { getApplicantStatus } from "@/modules/recruitment/services/portal-status";
import { applicantSignOutAction } from "./portal-actions";
import { SignInForm } from "./sign-in-form";
import { PortalShell } from "./portal-shell";
import { BrandBackdrop } from "@/platform/branding/brand-backdrop";
import { HavenLogo } from "@/platform/ui/haven-logo";
import { buttonClasses, Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";
import { Card, cardClasses } from "@/platform/ui/card";
import { getSetting } from "@/platform/settings/service";
import { getSupportContact } from "@/platform/branding/support";
import { SupportLink } from "@/platform/branding/support-link";
import { safeNextPath, PORTAL_HOME } from "@/modules/recruitment/services/portal-next";
import { SectionHeader } from "@/platform/ui/section-header";
import { cx } from "@/platform/ui/cx";

export const dynamic = "force-dynamic";

export default async function PortalHome({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  const identity = await getApplicantIdentity();

  if (!identity) {
    const [orgName, support] = await Promise.all([
      getSetting<string>("branding.orgName"),
      getSupportContact(),
    ]);
    // The deep-link an applicant was headed to before being bounced here (e.g.
    // /apply/<slug>). Thread it through both auth paths so post-sign-in lands on
    // that form; safeNextPath() blocks any open-redirect target.
    const safeNext = safeNextPath(next);
    const deepLink = safeNext === PORTAL_HOME ? undefined : safeNext;
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-6">
        <BrandBackdrop />
        <div className="glass-panel relative z-10 w-full max-w-md rounded-2xl p-8 shadow-xl">
          <HavenLogo className="mx-auto h-8 text-brand-fg" />
          <h1
            className="mt-5 text-center font-bold tracking-tight text-foreground"
            style={{ fontSize: "clamp(1.5rem, 1.25rem + 1.1vw, 1.9rem)" }}
          >
            Apply to {orgName}
          </h1>
          <p className="mt-2 text-center text-sm text-foreground-soft">
            Sign in to start a new application, pick up where you left off, or check your status.
          </p>

          {error === "link" && (
            <div className="mt-5">
              <Alert tone="error">That link has expired or was already used. Request a new one below.</Alert>
            </div>
          )}

          <a
            href={`/login?callbackUrl=${encodeURIComponent(safeNext)}`}
            className={buttonClasses("primary", "lg", "mt-6 w-full")}
          >
            Sign in with Yale
          </a>

          <div className="mt-6 border-t border-border-subtle pt-6">
            <p className="mb-3 text-center text-sm text-muted-foreground">
              Not affiliated with Yale? Get a one-time link by email.
            </p>
            <SignInForm next={deepLink} />
          </div>

          {support.email && (
            <p className="mt-6 text-center text-sm text-muted-foreground">
              Questions? <SupportLink email={support.email}>{support.label}</SupportLink>
            </p>
          )}
        </div>
      </div>
    );
  }

  const myApps = await getApplicantStatus(identity);

  const now = new Date();
  const openCycles = await prisma.recruitmentCycle.findMany({
    where: { status: "OPEN", AND: [{ OR: [{ opensAt: null }, { opensAt: { lte: now } }] }, { OR: [{ closesAt: null }, { closesAt: { gte: now } }] }] },
    select: { title: true, publicSlug: true },
    orderBy: { createdAt: "desc" },
  });

  const actionRow = cx(cardClasses({ interactive: true, pad: false }), "group flex items-center justify-between gap-4 px-4 py-3.5");
  const actionCue = "inline-flex shrink-0 items-center gap-1 text-sm font-medium text-brand-fg";
  const arrow = <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />;

  return (
    <PortalShell
      action={
        <form action={applicantSignOutAction}>
          <Button type="submit" variant="ghost" size="sm">Sign out</Button>
        </form>
      }
    >
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Your applications</h1>
        <p className="mt-1 text-sm text-muted-foreground">Signed in as {identity.email}.</p>
      </div>

      {myApps.length > 0 && (
        <ul className="mb-10 space-y-2">
          {myApps.map((a) => (
            <li key={a.slug}>
              {a.canContinue ? (
                <Link href={`/apply/${a.slug}`} className={actionRow}>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">{a.cycleTitle}</span>
                    <span className="block truncate text-xs text-muted-foreground">{a.detail}</span>
                  </span>
                  <span className={actionCue}>Continue{arrow}</span>
                </Link>
              ) : (
                <Card size="compact" pad={false} className="flex items-center justify-between gap-4 px-4 py-3.5">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">{a.cycleTitle}</span>
                    <span className="block truncate text-xs text-muted-foreground">{a.detail}</span>
                  </span>
                  <span className="shrink-0 text-sm font-medium text-foreground">{a.headline}</span>
                </Card>
              )}
            </li>
          ))}
        </ul>
      )}

      <section className="space-y-3">
        <SectionHeader>Open applications</SectionHeader>
        {openCycles.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border px-5 py-8 text-center">
            <p className="text-sm font-medium text-foreground">No applications are open right now</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
              Recruitment opens each term. Check back soon for the next cycle.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {openCycles.map((c) => (
              <li key={c.publicSlug}>
                <Link href={`/apply/${c.publicSlug}`} className={actionRow}>
                  <span className="truncate text-sm font-medium text-foreground">{c.title}</span>
                  <span className={actionCue}>Start application{arrow}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PortalShell>
  );
}
