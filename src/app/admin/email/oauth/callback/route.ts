import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { can } from "@/platform/rbac/engine";
import { exchangeCode } from "@/platform/email/oauth";
import { recordAudit } from "@/platform/audit";

/**
 * GET /admin/email/oauth/callback
 *
 * Microsoft redirects here after the admin consents in the delegated OAuth
 * flow. Route handlers cannot call next/navigation redirect(), so we return
 * NextResponse.redirect() responses instead.
 *
 * Security:
 *   - Requires a signed-in, active person with admin.manage_sync.
 *   - Validates the CSRF state cookie against the returned state.
 *   - The cookie is cleared on every exit path.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const back = (path: string): Response => {
    const res = NextResponse.redirect(new URL(path, request.url));
    res.cookies.set("mailer_oauth_state", "", { maxAge: 0, path: "/" });
    return res;
  };
  const errBack = (message: string): Response =>
    back(`/admin/email?error=validation&message=${encodeURIComponent(message)}`);

  // --- Auth: signed-in active person with the sync permission ---
  const session = await auth();
  if (!session?.personId) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  const person = await getActivePerson(session.personId);
  if (!person) {
    return NextResponse.redirect(new URL("/welcome", request.url));
  }
  if (!(await can(person.id, "admin.manage_sync"))) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const oauthError = params.get("error");

  const cookieState = (await cookies()).get("mailer_oauth_state")?.value ?? null;

  if (oauthError) {
    return errBack("Authorization was cancelled or failed.");
  }
  if (!code) {
    return errBack("Authorization was cancelled or failed.");
  }
  if (!cookieState || cookieState !== state) {
    return errBack("Invalid OAuth state.");
  }

  try {
    await exchangeCode(code);
  } catch {
    return errBack("Failed to connect the mailbox.");
  }

  await recordAudit({
    actorPersonId: person.id,
    action: "email.mailer_connect",
    entityType: "MailCredential",
    entityId: "mailer",
  });

  return back("/admin/email?connected=1");
}
