import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { signOut } from "@/platform/auth/auth";
import { HavenLogo } from "@/platform/ui/haven-logo";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { OnboardingChecklist } from "./onboarding-checklist";

export default async function GetStartedPage() {
  const person = await requirePersonSession();
  // /get-started is allowlisted in the onboarding gate, so the gate does not
  // compute status for this route; this is the authoritative check.
  const status = await getOnboardingStatus(person.personId);

  // Never a dead end: anyone who does not belong here goes to the hub.
  if (status.exempt || !status.hasActiveTerm || status.onboarded) redirect("/");

  const firstName = person.name ? person.name.trim().split(/\s+/)[0] : "there";
  const pct =
    status.totalCount > 0
      ? Math.round((status.completedCount / status.totalCount) * 100)
      : 0;

  return (
    <main className="grid min-h-screen grid-cols-1 bg-canvas md:grid-cols-[340px_1fr]">
      {/* Left rail */}
      <aside className="relative flex flex-col overflow-hidden bg-gradient-to-br from-brand to-brand-deep p-8 text-white md:p-10">
        <span
          className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-white/[0.07]"
          aria-hidden
        />
        <div className="relative flex flex-1 flex-col">
          <HavenLogo className="h-9 text-white" />
          <p className="mt-8 text-[11px] font-bold uppercase tracking-[0.14em] text-white/60">
            Getting started
          </p>
          <h1 className="mt-2 text-[26px] font-extrabold leading-tight tracking-tight">
            Let&apos;s get you cleared, {firstName}
          </h1>
          <p className="mt-3 text-[13.5px] leading-relaxed text-white/80">
            Complete these steps to be ready for shifts. You cannot be scheduled
            until each one is done, but you can finish them in any order.
          </p>
          <div className="mt-7">
            <div className="mb-2 flex justify-between text-[12px] font-semibold text-white/80">
              <span>Your progress</span>
              <span>
                {status.completedCount} of {status.totalCount}
              </span>
            </div>
            <div className="h-[7px] overflow-hidden rounded-full bg-white/20">
              <div
                className="h-full rounded-full bg-white transition-[width] duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
          <p className="mt-auto pt-7 text-[12.5px] text-white/60">
            Need help? Contact your recruitment director.
          </p>
        </div>
      </aside>

      {/* Right panel */}
      <section className="overflow-auto p-8 md:p-10">
        <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
          What&apos;s left
        </p>
        <OnboardingChecklist tasks={status.tasks} />
        <form
          className="mt-6 text-[13px] text-slate-500"
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          Wrong account?{" "}
          <button
            type="submit"
            className="font-semibold text-brand underline-offset-2 hover:underline"
          >
            Sign out
          </button>
        </form>
      </section>
    </main>
  );
}
