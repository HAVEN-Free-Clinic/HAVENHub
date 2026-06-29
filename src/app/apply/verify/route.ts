// src/app/apply/verify/route.ts
import { NextResponse } from "next/server";
import { verifyMagicToken, signApplicantCookie, APPLICANT_COOKIE } from "@/modules/recruitment/services/portal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeNext(raw: string | null): string {
  // Only allow a same-origin, slash-rooted path (no open redirect).
  if (raw && /^\/[^/\\]/.test(raw)) return raw;
  return "/apply";
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const next = safeNext(url.searchParams.get("next"));
  const email = token ? await verifyMagicToken(token) : null;
  if (!email) {
    return NextResponse.redirect(new URL("/apply?error=link", req.url));
  }
  const res = NextResponse.redirect(new URL(next, req.url));
  res.cookies.set({
    name: APPLICANT_COOKIE,
    value: signApplicantCookie(email),
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
  return res;
}
