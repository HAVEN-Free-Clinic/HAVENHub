import Image from "next/image";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { LogIn } from "lucide-react";
import { auth, signIn } from "@/platform/auth/auth";
import { config } from "@/platform/config";
import { getSetting } from "@/platform/settings/service";
import { getSupportContact } from "@/platform/branding/support";
import { SupportLink } from "@/platform/branding/support-link";
import { HavenLogo } from "@/platform/ui/haven-logo";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { FormActions } from "@/platform/ui/form";
import { SignInButton } from "./sign-in-button";

const ERROR_MESSAGES: Record<string, string> = {
  CredentialsSignin:
    "We couldn't sign you in. That email isn't in our records or the account isn't active.",
};
const DEFAULT_ERROR = "Sign-in failed. Please try again, or contact the IT team.";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const { error, callbackUrl } = await searchParams;
  // Only honor a same-origin, slash-rooted destination (e.g. the GitBook docs
  // auth endpoint) so the callback can never become an open redirect. Parsing
  // against APP_BASE_URL with the WHATWG URL API rejects absolute URLs and the
  // protocol-relative / backslash tricks ("//evil.com", "/\evil.com") that a
  // naive string check misses. Anything else falls back to the home page.
  let safeCallbackUrl = "/";
  if (callbackUrl) {
    try {
      const base = new URL(config.APP_BASE_URL);
      const target = new URL(callbackUrl, base);
      if (target.origin === base.origin && /^\/[^/\\]/.test(target.pathname)) {
        safeCallbackUrl = target.pathname + target.search;
      }
    } catch {
      // Malformed callbackUrl: keep the "/" default.
    }
  }
  const session = await auth();
  if (session?.personId) redirect(safeCallbackUrl);
  const [appName, support] = await Promise.all([
    getSetting<string>("branding.appName"),
    getSupportContact(),
  ]);
  const errorMessage = error ? (ERROR_MESSAGES[error] ?? DEFAULT_ERROR) : null;

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-6">
      {/* Full-bleed brand backdrop, softened to read airy rather than heavy */}
      <Image
        src="/brand/login-building.webp"
        alt=""
        aria-hidden="true"
        fill
        priority
        sizes="100vw"
        className="object-cover object-center"
      />
      {/* Airy brand wash: lighter than the old side panel, so the photo reads as
          atmospheric brand texture. Center stays brighter for the glass card. */}
      <div aria-hidden="true" className="absolute inset-0 bg-brand/30" />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-b from-brand-deep/55 via-brand/10 to-brand-deep/60"
      />
      {/* Extra weight in the top-left corner keeps the white logo legible. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-br from-brand-deep/45 via-transparent to-transparent"
      />

      {/* Brand lockup, top-left over the backdrop */}
      <div className="absolute left-6 top-6 z-10 sm:left-10 sm:top-10">
        <HavenLogo className="h-9 text-white" />
      </div>

      {/* Centered glass card */}
      <div className="glass-panel relative z-10 w-full max-w-sm rounded-2xl p-8 shadow-xl">
        <div
          aria-hidden="true"
          className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-surface shadow-sm"
        >
          <LogIn className="h-5 w-5 text-foreground" />
        </div>

        <h1 className="mt-5 text-center text-2xl font-bold tracking-tight text-foreground">
          Sign in to {appName}
        </h1>
        <p className="mt-2 text-center text-sm text-foreground-soft">
          Use your Yale account to continue.
        </p>

        {errorMessage && (
          <p
            role="alert"
            className="mt-5 rounded-xl border border-critical/20 bg-critical/5 px-3 py-2 text-sm text-critical"
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
                await signIn("microsoft-entra-id", { redirectTo: safeCallbackUrl });
              } catch (error) {
                if (error instanceof AuthError) {
                  redirect(
                    `/login?error=${error.type}&callbackUrl=${encodeURIComponent(safeCallbackUrl)}`
                  );
                }
                throw error;
              }
            }}
          >
            <SignInButton />
          </form>
        ) : (
          <p className="mt-6 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
            Entra ID is not configured (AZURE_AD_* unset).
          </p>
        )}

        {/* Persistent help affordance, available before any error occurs.
            Hidden entirely when no support email is configured, so a
            locked-out user is never shown a contact they cannot reach. */}
        {support.email && (
          <p className="mt-5 text-center text-sm text-muted-foreground">
            Trouble signing in?{" "}
            <SupportLink email={support.email}>{support.label}</SupportLink>
          </p>
        )}

        {(config.NODE_ENV !== "production" || config.DEMO_MODE) && (
          <form
            className="mt-8 border-t border-border-subtle pt-6"
            action={async (formData: FormData) => {
              "use server";
              try {
                await signIn("credentials", {
                  email: formData.get("email"),
                  redirectTo: safeCallbackUrl,
                });
              } catch (error) {
                // signIn throws NEXT_REDIRECT on success, so only translate auth failures.
                if (error instanceof AuthError) {
                  redirect(
                    `/login?error=${error.type}&callbackUrl=${encodeURIComponent(safeCallbackUrl)}`
                  );
                }
                throw error;
              }
            }}
          >
            <p className="text-xs font-medium uppercase tracking-wide text-subtle-foreground">
              Local development
            </p>
            <Field label="Email">
              <Input
                name="email"
                type="email"
                required
                placeholder="j.carney@yale.edu"
                className="mt-1"
              />
            </Field>
            <FormActions>
              <Button type="submit" variant="outline" className="w-full">
                Dev sign in
              </Button>
            </FormActions>
          </form>
        )}
      </div>
    </div>
  );
}
