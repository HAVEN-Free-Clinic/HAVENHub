import { redirect } from "next/navigation";
import Link from "next/link";
import { AuthError } from "next-auth";
import { signIn } from "@/platform/auth/auth";
import { peekMemberToken } from "@/platform/auth/member-magic-link";
import { safeLoginPath } from "@/platform/auth/safe-next";
import { HavenLogo } from "@/platform/ui/haven-logo";
import { buttonClasses } from "@/platform/ui/button";
import { SubmitButton } from "@/platform/ui/submit-button";
import { buildPageMetadata } from "@/platform/branding/metadata";

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return buildPageMetadata({ title: "Confirm sign-in" });
}

/**
 * Member magic-link verification with an explicit confirmation step. The GET
 * only peeks the token (does not consume it) and shows "sign in as <name>?".
 * The session is established only when the member confirms, which consumes the
 * token via signIn("member-magic-link"). This defeats a login-CSRF where an
 * attacker forwards a link issued for their own address to a victim.
 */
export default async function MemberVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; next?: string }>;
}) {
  const sp = await searchParams;
  const token = sp.token ?? "";
  const next = safeLoginPath(sp.next ?? null);
  const peeked = token ? await peekMemberToken(token) : null;

  async function confirmAction(formData: FormData) {
    "use server";
    const rawToken = String(formData.get("token") ?? "");
    const confirmedNext = safeLoginPath((formData.get("next") as string | null) ?? null);
    try {
      await signIn("member-magic-link", { token: rawToken, redirectTo: confirmedNext });
    } catch (error) {
      // signIn throws NEXT_REDIRECT on success (re-throw it); only translate auth failures.
      if (error instanceof AuthError) {
        // This action only ever calls signIn("member-magic-link"), so a
        // CredentialsSignin here means verifyAndConsumeMemberToken returned null --
        // the token expired (30-min TTL) or was already consumed between the GET peek
        // and this POST. Map it to a dedicated, actionable code so the member is told
        // to request a fresh link, not that their account "isn't active" (#94).
        const code = error.type === "CredentialsSignin" ? "MemberLinkExpired" : error.type;
        redirect(`/login?error=${code}&callbackUrl=${encodeURIComponent(confirmedNext)}`);
      }
      throw error;
    }
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-canvas p-6">
      <div className="glass-panel relative z-10 w-full max-w-sm rounded-2xl p-8 shadow-xl">
        <HavenLogo className="mx-auto h-10 w-auto" />
        {!peeked ? (
          <div className="mt-6 text-center">
            <h1 className="text-lg font-semibold text-foreground">This link is invalid or expired</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Sign-in links can be used once and expire after 30 minutes. Request a new one to continue.
            </p>
            <Link href="/login" className={buttonClasses("primary", "md", "mt-6 w-full")}>
              Back to sign in
            </Link>
          </div>
        ) : (
          <div className="mt-6 text-center">
            <h1 className="text-lg font-semibold text-foreground">Confirm sign-in</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              You are about to sign in as{" "}
              <strong className="text-foreground">{peeked.name}</strong> ({peeked.email}). If that is not
              you, do not continue.
            </p>
            <form action={confirmAction} className="mt-6">
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="next" value={next} />
              <SubmitButton className="w-full" pendingLabel="Signing in…">
                Continue
              </SubmitButton>
            </form>
            <Link href="/login" className={buttonClasses("outline", "md", "mt-3 w-full")}>
              This is not me
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
