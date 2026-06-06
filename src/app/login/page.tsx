import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { auth, signIn } from "@/platform/auth/auth";
import { config } from "@/platform/config";
import { HavenLogo } from "@/platform/ui/haven-logo";

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
      {/* Left brand panel (desktop only) */}
      <div className="hidden lg:flex bg-brand text-white flex-col justify-between p-10 relative overflow-hidden">
        {/* Plus-sign motif overlay */}
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <pattern
              id="plus-pattern"
              x="0"
              y="0"
              width="24"
              height="24"
              patternUnits="userSpaceOnUse"
            >
              {/* Horizontal bar of + */}
              <rect x="10" y="11" width="4" height="2" fill="white" />
              {/* Vertical bar of + */}
              <rect x="11" y="10" width="2" height="4" fill="white" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#plus-pattern)" opacity="0.06" />
        </svg>

        {/* Top: official lockup */}
        <div className="relative z-10">
          <HavenLogo className="h-16 text-white" />
        </div>

        {/* Bottom: copy */}
        <div className="relative z-10">
          <p className="text-2xl font-semibold tracking-tight leading-snug">
            One platform for the clinic.
          </p>
          <p className="mt-2 text-sm text-white/70">
            Scheduling, volunteer management, and compliance in one place.
          </p>
          <p className="mt-8 text-xs text-white/50">HAVEN Free Clinic · Yale University</p>
        </div>
      </div>

      {/* Mobile top band */}
      <div className="flex lg:hidden items-center bg-brand px-6 py-4 text-white">
        <HavenLogo className="h-9 text-white" />
      </div>

      {/* Right panel */}
      <div className="flex items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <h1 className="text-xl font-semibold tracking-tight">Sign in to HAVEN Hub</h1>
          <p className="mt-1 text-sm text-slate-500">Use your Yale account to continue.</p>

          {errorMessage && (
            <p
              role="alert"
              className="mt-4 rounded-md border border-critical/20 bg-red-50 px-3 py-2 text-sm text-critical"
            >
              {errorMessage}
            </p>
          )}

          {config.AZURE_AD_CLIENT_ID ? (
            <form
              className="mt-6"
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
              <button
                type="submit"
                className="w-full rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                Sign in with Yale
              </button>
            </form>
          ) : (
            <p className="mt-6 rounded-md border border-warning/30 bg-amber-50 px-3 py-2 text-sm text-warning">
              Entra ID is not configured (AZURE_AD_* unset).
            </p>
          )}

          {config.NODE_ENV !== "production" && (
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
