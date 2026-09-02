import Image from "next/image";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { auth, signIn } from "@/platform/auth/auth";
import { config } from "@/platform/config";
import { getSetting } from "@/platform/settings/service";
import { getSupportContact } from "@/platform/branding/support";
import { MessengerSupportLink } from "@/platform/intercom/messenger-support-link";
import { HavenLogo } from "@/platform/ui/haven-logo";
import { CopyrightNotice } from "@/platform/ui/app-footer";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { FormActions } from "@/platform/ui/form";
import { SignInButton } from "./sign-in-button";
import { MemberSignInForm } from "./member-sign-in-form";
import { signInWithYaleAction } from "./login-actions";
import { safeLoginPath } from "@/platform/auth/safe-next";
import { buildPageMetadata } from "@/platform/branding/metadata";

const ERROR_MESSAGES: Record<string, string> = {
  CredentialsSignin:
    "We couldn't sign you in. That email isn't in our records or the account isn't active.",
  MemberLinkExpired:
    "That sign-in link has expired or was already used. Request a new one below.",
};
const DEFAULT_ERROR = "Sign-in failed. Please try again, or contact the IT team.";

export function generateMetadata() {
  return buildPageMetadata({ title: "Sign in" });
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const { error, callbackUrl } = await searchParams;
  // Only honor a same-origin, slash-rooted destination so the callback can never
  // become an open redirect; anything else falls back to home. See `safeLoginPath`.
  const safeCallbackUrl = safeLoginPath(callbackUrl);
  const session = await auth();
  if (session?.personId) redirect(safeCallbackUrl);
  const [appName, support, memberLinkEnabled] = await Promise.all([
    getSetting<string>("branding.appName"),
    getSupportContact(),
    getSetting<boolean>("auth.memberMagicLinkEnabled"),
  ]);
  const errorMessage = error ? (ERROR_MESSAGES[error] ?? DEFAULT_ERROR) : null;

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-6 overflow-hidden p-6">
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

      {/* Centered glass card */}
      <div className="glass-panel relative z-10 w-full max-w-sm rounded-2xl p-8 shadow-xl">
        {/* Brand lockup at the top of the card.

            h-14 rather than h-8: at 32px the lockup sat well under the size of
            the "Sign in" heading below it and read as an afterthought, which is
            backwards for the first thing on the page.

            text-brand-fg stays. It is not a recolor of a colored asset -- the
            bundled logo is a white silhouette (public/brand/haven-logo-white.png,
            which is what the branding route falls back to), so the mask fill is
            the ONLY thing giving it a color at all. Dropping it renders the logo
            white on a white card. */}
        <HavenLogo className="mx-auto h-14 text-brand-fg" />

        <h1 className="mt-5 text-center text-2xl font-bold tracking-tight text-foreground">
          Sign in to {appName}
        </h1>
        <p className="mt-2 text-center text-sm text-foreground-soft">
          Use your Yale account to continue.
        </p>

        {errorMessage && (
          <p
            role="alert"
            className="mt-5 rounded-xl border border-critical/20 bg-critical/5 px-3 py-2 text-sm text-critical-foreground"
          >
            {errorMessage}
          </p>
        )}

        {config.AZURE_AD_CLIENT_ID ? (
          <form className="mt-6" action={signInWithYaleAction}>
            <input type="hidden" name="callbackUrl" value={safeCallbackUrl} />
            <SignInButton />
          </form>
        ) : (
          <p className="mt-6 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning-foreground">
            Entra ID is not configured (AZURE_AD_* unset).
          </p>
        )}

        {memberLinkEnabled && (
          <div className="mt-6 border-t border-border-subtle pt-4">
            {/* Collapsed by default: Yale SSO is the path for nearly everyone.
                An expired member link is the one case where the error copy
                points at this form, so open it up front there. */}
            <MemberSignInForm
              callbackUrl={safeCallbackUrl}
              defaultOpen={error === "MemberLinkExpired"}
            />
          </div>
        )}

        {/* Persistent help affordance, available before any error occurs.
            Hidden entirely when no support email is configured, so a
            locked-out user is never shown a contact they cannot reach.

            Opens the Intercom Messenger rather than a mail client whenever the
            Messenger is actually up: this layout already boots it in visitor
            mode (see ./layout.tsx), and a locked-out person gets an answer in
            the chat far sooner than in an inbox. It stays a mailto link
            underneath for the cases where the widget never loads at all --
            content blocker, filtered network, integration switched off. */}
        {support.email && (
          <p className="mt-5 text-center text-sm text-muted-foreground">
            Trouble signing in?{" "}
            <MessengerSupportLink email={support.email}>{support.label}</MessengerSupportLink>
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
                placeholder="netid@yale.edu"
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

      <CopyrightNotice tone="onBrand" className="relative z-10 text-center" />
    </div>
  );
}
