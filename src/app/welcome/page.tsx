import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/platform/auth/auth";
import { getActivePerson, resolvePersonForLogin } from "@/platform/auth/match-person";
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { getSupportContact } from "@/platform/branding/support";
import { SupportLink } from "@/platform/branding/support-link";
import { HavenLogo } from "@/platform/ui/haven-logo";
import { Button, buttonClasses } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { CopyrightNotice } from "@/platform/ui/app-footer";
import { resolveSupportAppId } from "@/platform/intercom/config";
import { IntercomMessenger } from "@/platform/intercom/messenger";

export default async function WelcomePage() {
  // Self-heal the promoted-applicant case (#65): a Yale-SSO applicant whose session
  // still carries a stale personId:null but who now has a Person (promotion created
  // one) should not read "we couldn't find you / contact IT". Re-resolve from the
  // verified applicantEmail in the token and send them into the hub if matched.
  const session = await auth();
  // Ask the database, not the token. The JWT stamps personId at sign-in and lives
  // 7 days, so an offboarded member still presents one long after their access
  // ended -- and the (app) layout, which re-reads Person.status on every render,
  // sends exactly those people here. Trusting personId alone bounced them
  // /welcome -> / -> /welcome until the browser gave up: they could reach neither
  // /login nor the Sign out button below, so the one session they needed to clear
  // was the only thing they could not do (audit 14,
  // offboarded-session-welcome-redirect-loop). This page is their terminal stop.
  const activePerson = session?.personId ? await getActivePerson(session.personId) : null;
  if (activePerson) redirect("/");
  const accessEnded = Boolean(session?.personId) && !activePerson;
  // Only for a token that names no Person at all, which is what the #65 self-heal
  // above is about. An offboarded member's token DOES name one, and running the
  // resolver for them would re-link their Entra oid to a record their sign-in was
  // already refused for -- a write on a page whose whole job is to let them leave.
  if (!accessEnded && session?.applicantEmail) {
    const resolved = await resolvePersonForLogin({
      upn: session.applicantEmail,
      email: session.applicantEmail,
    });
    if (resolved && resolved.status === "ACTIVE") redirect("/");
  }

  const now = new Date();
  const [orgName, support, openCycleCount] = await Promise.all([
    getSetting<string>("branding.orgName"),
    getSupportContact(),
    prisma.recruitmentCycle.count({
      where: {
        status: "OPEN",
        AND: [
          { OR: [{ opensAt: null }, { opensAt: { lte: now } }] },
          { OR: [{ closesAt: null }, { closesAt: { gte: now } }] },
        ],
      },
    }),
  ]);
  const supportAppId = resolveSupportAppId();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-muted p-6">
      {/* mode="identified", no requireActiveMembership: this page is reached
          precisely when the session does NOT resolve to a Person (the
          redirects above send anyone who does resolve straight into the
          hub), so the common case here is the token route's 401 falling back
          to visitor -- see IntercomMessenger's doc comment. No BlockerGate --
          that stays (app)-only by design, see blocker-gate.tsx. */}
      {supportAppId ? <IntercomMessenger appId={supportAppId} mode="identified" /> : null}
      <Card pad={false} className="w-full max-w-md p-8">
        <HavenLogo className="h-10 text-brand-fg" />
        <h1 className="mt-4 text-2xl font-bold tracking-tight">
          {accessEnded ? `Your ${orgName} access has ended` : `Welcome to ${orgName}`}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-foreground-soft">
          {/* Two audiences, one page. Someone we never had a record for needs
              "we couldn't find you"; an offboarded member needs to be told their
              access ended, not that we lost them. Both then need the same thing:
              the Sign out button below, which is the only way to clear a session
              that no longer opens anything. */}
          {accessEnded ? (
            <>
              You signed in successfully, but your membership is no longer active, so the hub is
              closed to you.{" "}
              {support.email ? (
                <>
                  If that is wrong, contact{" "}
                  <SupportLink email={support.email}>the IT team</SupportLink> and we can restore
                  your record.
                </>
              ) : (
                <>If that is wrong, reach out to your director and we can restore your record.</>
              )}
              {openCycleCount > 0
                ? " If you'd like to come back, you can start an application now."
                : " If you'd like to come back, keep an eye out for the next recruitment cycle."}
            </>
          ) : (
            <>
              You signed in successfully, but we couldn&apos;t find you in our records.{" "}
              {support.email ? (
                <>
                  If you&apos;re a current member, contact{" "}
                  <SupportLink email={support.email}>the IT team</SupportLink> so we can fix your
                  record.
                </>
              ) : (
                <>
                  If you&apos;re a current member, reach out to your recruitment director so we can
                  fix your record.
                </>
              )}
              {openCycleCount > 0
                ? " If you'd like to join, you can start an application now."
                : " If you'd like to join, keep an eye out for the next recruitment cycle."}
            </>
          )}
        </p>
        {openCycleCount > 0 && (
          <Link href="/apply" className={buttonClasses("primary", "md", "mt-6 w-full")}>
            Start an application
          </Link>
        )}
        <form
          className="mt-3"
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <Button type="submit" variant="outline">Sign out</Button>
        </form>
      </Card>
      <CopyrightNotice className="text-center" />
    </main>
  );
}
