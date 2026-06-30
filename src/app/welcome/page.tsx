import { signOut } from "@/platform/auth/auth";
import { getSetting } from "@/platform/settings/service";
import { HavenLogo } from "@/platform/ui/haven-logo";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";

export default async function WelcomePage() {
  const orgName = await getSetting<string>("branding.orgName");
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted p-6">
      <Card pad={false} className="w-full max-w-md p-8">
        <HavenLogo className="h-10 text-brand-fg" />
        <h1 className="mt-4 text-2xl font-bold tracking-tight">Welcome to {orgName}</h1>
        <p className="mt-3 text-sm leading-relaxed text-foreground-soft">
          You signed in successfully, but we couldn&apos;t find you in our records.
          If you&apos;re a current member, contact the IT team so we can fix your
          record. If you&apos;d like to join HAVEN, keep an eye out for the next
          recruitment cycle.
        </p>
        <form
          className="mt-6"
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
