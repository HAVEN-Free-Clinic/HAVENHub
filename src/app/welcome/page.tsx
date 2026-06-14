import { signOut } from "@/platform/auth/auth";
import { HavenLogo } from "@/platform/ui/haven-logo";

export default function WelcomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-8 shadow-sm">
        <HavenLogo className="h-10 text-brand-fg" />
        <h1 className="mt-4 text-2xl font-bold tracking-tight">Welcome to HAVEN Free Clinic</h1>
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
          <button
            type="submit"
            className="rounded-lg border border-border-strong px-4 py-2 text-sm font-medium text-foreground-soft transition-colors hover:bg-muted"
          >
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
