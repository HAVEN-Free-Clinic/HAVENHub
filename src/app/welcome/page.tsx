import { signOut } from "@/platform/auth/auth";
import { HavenLogo } from "@/platform/ui/haven-logo";

export default function WelcomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <HavenLogo className="h-10 text-brand" />
        <h1 className="mt-4 text-xl font-semibold tracking-tight">Welcome to HAVEN Free Clinic</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
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
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
          >
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
