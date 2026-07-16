import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import {
  peekMagicToken,
  verifyMagicToken,
  signApplicantCookie,
  APPLICANT_COOKIE,
} from "@/modules/recruitment/services/portal-auth";
import { safeNextPath } from "@/modules/recruitment/services/portal-next";
import { PortalShell } from "../portal-shell";
import { PortalNotice } from "../portal-notice";
import { buttonClasses } from "@/platform/ui/button";
import { SubmitButton } from "@/platform/ui/submit-button";

export const dynamic = "force-dynamic";

/**
 * Magic-link verification with an explicit confirmation step.
 *
 * The GET only *peeks* the token (does not consume it) and shows "sign in as
 * <email>?". The session is set only when the applicant confirms, which consumes
 * the token. This defeats a login-CSRF where an attacker forwards a link issued
 * for their own address to a victim: the victim now sees whose account they are
 * about to enter and must consciously confirm, instead of being silently signed
 * into the attacker's session. (Kept cross-device: the link still works on a
 * different device than it was requested from.)
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; next?: string }>;
}) {
  const sp = await searchParams;
  const token = sp.token ?? "";
  const next = safeNextPath(sp.next ?? null);
  const email = token ? await peekMagicToken(token) : null;

  async function confirmAction(formData: FormData) {
    "use server";
    const rawToken = String(formData.get("token") ?? "");
    const confirmedNext = safeNextPath((formData.get("next") as string | null) ?? null);
    const verifiedEmail = rawToken ? await verifyMagicToken(rawToken) : null;
    if (!verifiedEmail) redirect("/apply?error=link");
    const store = await cookies();
    store.set({
      name: APPLICANT_COOKIE,
      value: signApplicantCookie(verifiedEmail),
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
    });
    redirect(confirmedNext);
  }

  if (!email) {
    return (
      <PortalShell>
        <PortalNotice
          tone="error"
          title="This link is invalid or expired"
          action={
            <Link href="/apply" className={buttonClasses("primary", "md")}>
              Back to sign in
            </Link>
          }
        >
          <p>Magic links can only be used once and expire after 30 minutes. Request a new one to continue.</p>
        </PortalNotice>
      </PortalShell>
    );
  }

  return (
    <PortalShell>
      <PortalNotice
        tone="neutral"
        title="Confirm sign-in"
        action={
          <div className="flex flex-wrap items-center justify-center gap-3">
            <form action={confirmAction}>
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="next" value={next} />
              <SubmitButton>Continue</SubmitButton>
            </form>
            <Link href="/apply" className={buttonClasses("outline", "md")}>
              This isn&rsquo;t me
            </Link>
          </div>
        }
      >
        <p>
          You&rsquo;re about to sign in to the application portal as{" "}
          <strong className="text-foreground">{email}</strong>.
        </p>
        <p>If that isn&rsquo;t your email, do not continue.</p>
      </PortalNotice>
    </PortalShell>
  );
}
