// src/modules/recruitment/services/portal-auth.ts
import { randomBytes, createHash } from "node:crypto";
import { prisma } from "@/platform/db";

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Create a single-use magic-link token for `email` and return the raw token
 *  (only its hash is stored). */
export async function issueMagicToken(email: string): Promise<string> {
  const emailLower = email.trim().toLowerCase();
  const raw = randomBytes(32).toString("base64url");
  await prisma.applicantPortalToken.create({
    data: { emailLower, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
  });
  return raw;
}

/** Validate a raw token: returns the emailLower and marks it used, or null if
 *  it is unknown, already used, or expired. */
export async function verifyMagicToken(rawToken: string): Promise<string | null> {
  const tokenHash = hashToken(rawToken);
  // Atomically claim the token: the WHERE clause only matches an unused,
  // unexpired row, and a row-level lock means exactly one concurrent caller
  // flips usedAt. This closes the check-then-update race (TOCTOU) so the
  // single-use guarantee holds.
  const claimed = await prisma.applicantPortalToken.updateMany({
    where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) return null;
  const token = await prisma.applicantPortalToken.findUnique({
    where: { tokenHash },
    select: { emailLower: true },
  });
  return token?.emailLower ?? null;
}

// ---------------------------------------------------------------------------
// Applicant session cookie (signed) + unified identity resolver
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { auth } from "@/platform/auth/auth";
import { config } from "@/platform/config";

export const APPLICANT_COOKIE = "applicant_session";
const COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function sign(data: string): string {
  return createHmac("sha256", config.AUTH_SECRET).update(data).digest("base64url");
}

/** Sign a payload.signature cookie carrying the verified email + expiry. */
export function signApplicantCookie(email: string): string {
  const payload = Buffer.from(
    JSON.stringify({ email: email.trim().toLowerCase(), exp: Date.now() + COOKIE_TTL_MS }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Validate the cookie and return its emailLower, or null if forged/expired. */
export function readApplicantCookie(value: string | undefined): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      email?: unknown;
      exp?: unknown;
    };
    if (
      typeof parsed.email !== "string" ||
      typeof parsed.exp !== "number" ||
      parsed.exp < Date.now()
    )
      return null;
    return parsed.email;
  } catch {
    return null;
  }
}

export type ApplicantIdentity = { email: string; personId: string | null };

/** The current applicant: from the NextAuth Person session if signed in,
 *  otherwise from the signed applicant cookie, otherwise null. */
export async function getApplicantIdentity(): Promise<ApplicantIdentity | null> {
  const session = await auth();
  if (session?.personId && session.user?.email) {
    return { email: session.user.email.toLowerCase(), personId: session.personId };
  }
  const store = await cookies();
  const email = readApplicantCookie(store.get(APPLICANT_COOKIE)?.value);
  return email ? { email, personId: null } : null;
}

// ---------------------------------------------------------------------------
// Magic-link request (rate-limited)
// ---------------------------------------------------------------------------

import { queueEmail } from "@/platform/email/send";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { getSetting } from "@/platform/settings/service";
import { safeNextPath, PORTAL_HOME } from "./portal-next";

const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_MAX = 3;

/** Issue a magic-link token and email it, unless the email has already been
 *  sent RATE_MAX links in the last window (silently skip to avoid spam).
 *  `next` is the deep-link the applicant was headed to before signing in; when
 *  it is a safe same-origin path it is threaded into the verify URL so the
 *  post-sign-in redirect lands on that form rather than the portal home. */
export async function requestMagicLink(email: string, next?: string | null): Promise<void> {
  const emailLower = email.trim().toLowerCase();
  const recent = await prisma.applicantPortalToken.count({
    where: { emailLower, createdAt: { gt: new Date(Date.now() - RATE_WINDOW_MS) } },
  });
  if (recent >= RATE_MAX) return;

  const raw = await issueMagicToken(emailLower);
  // Resolve the public base URL through the admin-configurable setting (a trusted
  // deploy/admin value, never the request Host header), matching every other
  // outbound-email link. Using config.APP_BASE_URL directly here meant the magic
  // link alone ignored a configured custom domain and emitted the raw env value.
  const baseUrl = await getSetting<string>("app.baseUrl");
  // Only append next when it resolves to a real deep link (not the home default),
  // keeping the common "sign in from the portal home" link clean. The verify
  // route re-validates before redirecting, so this is defence in depth.
  const safeNext = next ? safeNextPath(next) : PORTAL_HOME;
  const nextParam = safeNext === PORTAL_HOME ? "" : `&next=${encodeURIComponent(safeNext)}`;
  const url = `${baseUrl}/apply/verify?token=${encodeURIComponent(raw)}${nextParam}`;
  const mail = await renderEmail("recruitment.portal_link", { firstName: "there", portalUrl: url });
  await queueEmail(prisma, { to: emailLower, subject: mail.subject, html: mail.html, template: "recruitment.portal_link" });
}
