import { NextResponse } from "next/server";
import { verifyMagicToken, signApplicantCookie, APPLICANT_COOKIE } from "@/modules/recruitment/services/portal-auth";
import { safeNextPath } from "@/modules/recruitment/services/portal-next";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const next = safeNextPath(url.searchParams.get("next"));
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
