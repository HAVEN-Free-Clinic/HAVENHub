import { signOut } from "@/platform/auth/auth";

export default function WelcomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold">Welcome to HAVEN Free Clinic</h1>
        <p className="mt-3 text-sm text-slate-600">
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
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50"
          >
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
