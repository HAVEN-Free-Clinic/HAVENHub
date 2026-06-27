import Link from "next/link";
import { prisma } from "@/platform/db";
import { getApplicantIdentity } from "@/modules/recruitment/services/portal-auth";
import { getApplicantStatus } from "@/modules/recruitment/services/portal-status";
import { applicantSignOutAction } from "./portal-actions";
import { SignInForm } from "./sign-in-form";
import { buttonClasses } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";

export const dynamic = "force-dynamic";

export default async function PortalHome({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const identity = await getApplicantIdentity();

  if (!identity) {
    return (
      <main className="mx-auto max-w-md px-6 py-16 space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">HAVEN Free Clinic Application Portal</h1>
        {error === "link" && <Alert tone="error">That link has expired or was already used. Request a new one below.</Alert>}
        <p className="text-sm text-muted-foreground">Sign in to start, continue, or check the status of an application.</p>
        <a href="/login?callbackUrl=/apply" className={buttonClasses("primary", "md")}>Sign in with Yale</a>
        <div className="border-t border-border-subtle pt-6">
          <p className="mb-2 text-sm text-muted-foreground">Or get a one-time link by email:</p>
          <SignInForm />
        </div>
      </main>
    );
  }

  const myApps = await getApplicantStatus(identity);

  const now = new Date();
  const openCycles = await prisma.recruitmentCycle.findMany({
    where: { status: "OPEN", AND: [{ OR: [{ opensAt: null }, { opensAt: { lte: now } }] }, { OR: [{ closesAt: null }, { closesAt: { gte: now } }] }] },
    select: { title: true, publicSlug: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <main className="mx-auto max-w-2xl px-6 py-10 space-y-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight">Your applications</h1>
        <form action={applicantSignOutAction}><button className="text-sm text-muted-foreground hover:text-foreground">Sign out</button></form>
      </div>
      <p className="text-sm text-muted-foreground">Signed in as {identity.email}.</p>

      {myApps.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Your applications</h2>
          <ul className="space-y-2">
            {myApps.map((a) => (
              <li key={a.slug}>
                {a.canContinue ? (
                  <Link href={`/apply/${a.slug}`} className="flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 hover:bg-muted">
                    <span><span className="block text-sm font-medium text-foreground">{a.cycleTitle}</span><span className="block text-xs text-muted-foreground">{a.detail}</span></span>
                    <span className="text-sm text-brand-fg">Continue</span>
                  </Link>
                ) : (
                  <div className="flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3">
                    <span><span className="block text-sm font-medium text-foreground">{a.cycleTitle}</span><span className="block text-xs text-muted-foreground">{a.detail}</span></span>
                    <span className="text-sm font-medium text-foreground">{a.headline}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Open applications</h2>
        {openCycles.length === 0 && <p className="text-sm text-subtle-foreground">No applications are open right now.</p>}
        <ul className="space-y-2">
          {openCycles.map((c) => (
            <li key={c.publicSlug}>
              <Link href={`/apply/${c.publicSlug}`} className="flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 text-sm hover:bg-muted">
                <span className="font-medium text-foreground">{c.title}</span>
                <span className="text-brand-fg">Start application</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
