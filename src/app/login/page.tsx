import Image from "next/image";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { auth, signIn } from "@/platform/auth/auth";
import { config } from "@/platform/config";
import { HavenLogo } from "@/platform/ui/haven-logo";
import { SignInButton } from "./sign-in-button";

const ERROR_MESSAGES: Record<string, string> = {
  CredentialsSignin:
    "We couldn't sign you in. That email isn't in our records or the account isn't active.",
};
const DEFAULT_ERROR = "Sign-in failed. Please try again, or contact the IT team.";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (session?.personId) redirect("/");
  const { error } = await searchParams;
  const errorMessage = error ? (ERROR_MESSAGES[error] ?? DEFAULT_ERROR) : null;

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[45%_1fr]">
      {/* Left brand panel (desktop only): Yale Physicians Building under a Yale-blue overlay */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-brand-deep p-10 text-white lg:flex">
        <Image
          src="/brand/login-building.webp"
          alt=""
          aria-hidden="true"
          fill
          priority
          sizes="(min-width: 1024px) 45vw, 0px"
          className="object-cover object-center"
        />
        {/* Yale-blue tint mutes the photo to brand-monochrome texture */}
        <div aria-hidden="true" className="absolute inset-0 bg-brand/70" />
        {/* Vertical gradient: heavier at top and bottom so the logo and copy stay legible */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-b from-brand-deep/80 via-brand-deep/20 to-brand-deep/90"
        />

        {/* Top: official lockup */}
        <div className="relative z-10">
          <HavenLogo className="h-16 text-white" />
        </div>

        {/* Bottom: copy */}
        <div className="relative z-10">
          <p className="text-2xl font-semibold leading-snug tracking-tight">
            One platform for the clinic.
          </p>
          <p className="mt-2 text-sm text-white/80">
            Scheduling, volunteer management, and compliance in one place.
          </p>
          <p className="mt-8 text-xs text-white/70">HAVEN Free Clinic · Yale University</p>
        </div>
      </div>

      {/* Mobile top band: condensed identity + value prop for first-time recruits on a phone */}
      <div className="flex flex-col gap-1.5 bg-brand px-6 py-5 text-white lg:hidden">
        <HavenLogo className="h-9 text-white" />
        <p className="text-sm text-white/80">
          Scheduling, volunteering, and compliance for HAVEN Free Clinic.
        </p>
      </div>

      {/* Right panel */}
      <div className="flex items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Sign in to HAVEN Hub
          </h1>
          <p className="mt-2 text-sm text-slate-600">Use your Yale account to continue.</p>

          {errorMessage && (
            <p
              role="alert"
              className="mt-5 rounded-md border border-critical/20 bg-critical/5 px-3 py-2 text-sm text-critical"
            >
              {errorMessage}
            </p>
          )}

          {config.AZURE_AD_CLIENT_ID ? (
            <form
              className="mt-7"
              action={async () => {
                "use server";
                try {
                  await signIn("microsoft-entra-id", { redirectTo: "/" });
                } catch (error) {
                  if (error instanceof AuthError) {
                    redirect(`/login?error=${error.type}`);
                  }
                  throw error;
                }
              }}
            >
              <SignInButton />
            </form>
          ) : (
            <p className="mt-7 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
              Entra ID is not configured (AZURE_AD_* unset).
            </p>
          )}

          {/* Persistent help affordance, available before any error occurs */}
          <p className="mt-5 text-sm text-slate-500">
            Trouble signing in?{" "}
            <a
              href="mailto:hfc.it@yale.edu"
              className="font-medium text-brand underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              Contact the HAVEN IT team
            </a>
          </p>

          {(config.NODE_ENV !== "production" || config.DEMO_MODE) && (
            <form
              className="mt-8 border-t border-slate-100 pt-6"
              action={async (formData: FormData) => {
                "use server";
                try {
                  await signIn("credentials", {
                    email: formData.get("email"),
                    redirectTo: "/",
                  });
                } catch (error) {
                  // signIn throws NEXT_REDIRECT on success, so only translate auth failures.
                  if (error instanceof AuthError) {
                    redirect(`/login?error=${error.type}`);
                  }
                  throw error;
                }
              }}
            >
              <label
                className="text-xs font-medium uppercase tracking-wide text-slate-400"
                htmlFor="email"
              >
                Local development
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                placeholder="j.carney@yale.edu"
                className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15"
              />
              <button
                type="submit"
                className="mt-3 w-full rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                Dev sign in
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
