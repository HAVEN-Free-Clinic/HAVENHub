import Link from "next/link";
import { signOut } from "@/platform/auth/auth";
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { getSupportContact } from "@/platform/branding/support";
import { SupportLink } from "@/platform/branding/support-link";
import { HavenLogo } from "@/platform/ui/haven-logo";
import { Button, buttonClasses } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";

export default async function WelcomePage() {
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
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted p-6">
      <Card pad={false} className="w-full max-w-md p-8">
        <HavenLogo className="h-10 text-brand-fg" />
        <h1 className="mt-4 text-2xl font-bold tracking-tight">Welcome to {orgName}</h1>
        <p className="mt-3 text-sm leading-relaxed text-foreground-soft">
          You signed in successfully, but we couldn&apos;t find you in our records.{" "}
          {support.email ? (
            <>
              If you&apos;re a current member, contact{" "}
              <SupportLink email={support.email}>the IT team</SupportLink> so we can fix your record.
            </>
          ) : (
            <>If you&apos;re a current member, reach out to your recruitment director so we can fix your record.</>
          )}
          {openCycleCount > 0
            ? " If you'd like to join, you can start an application now."
            : " If you'd like to join, keep an eye out for the next recruitment cycle."}
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
    </main>
  );
}
