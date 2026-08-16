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

/** Validate a raw token WITHOUT consuming it: returns emailLower for a known,
 *  unused, unexpired token, else null. The verify page peeks first to render the
 *  "sign in as <email>?" confirmation, and only verifyMagicToken (below) claims
 *  the token once the applicant confirms -- so a link forwarded to a victim cannot
 *  silently sign them into the requester's account without an explicit confirm. */
export async function peekMagicToken(rawToken: string): Promise<string | null> {
  const token = await prisma.applicantPortalToken.findFirst({
    where: { tokenHash: hashToken(rawToken), usedAt: null, expiresAt: { gt: new Date() } },
    select: { emailLower: true },
  });
  return token?.emailLower ?? null;
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
import { cookies, headers } from "next/headers";
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

export type ApplicantIdentity = { email: string; personId: string | null; firstName: string | null };

/** The current applicant: from the NextAuth Person session if signed in,
 *  otherwise from the signed applicant cookie, otherwise null.
 *  `firstName` is the name from the Entra sign-in (null on the magic-link cookie
 *  path, which carries only a verified email). */
export async function getApplicantIdentity(): Promise<ApplicantIdentity | null> {
  const session = await auth();
  if (session?.personId && session.user?.email) {
    return { email: session.user.email.toLowerCase(), personId: session.personId, firstName: session.applicantFirstName ?? null };
  }
  // A tenant-valid Yale login that matched no Person still carries a verified email
  // (stamped in the jwt callback). Treat it as a prospective applicant, exactly like
  // the magic-link cookie path. personId is preserved if present so a recognized
  // member who happens to lack a user.email claim is never downgraded.
  if (session?.applicantEmail) {
    return { email: session.applicantEmail, personId: session.personId ?? null, firstName: session.applicantFirstName ?? null };
  }
  // A member signed in via the member-magic-link provider has personId set but
  // NEITHER user.email NOR applicantEmail (authorize returns only { id }). Without
  // this branch they fell through to the cookie and got null -- a fully signed-in
  // member treated as anonymous, bounced to "Sign in with Yale". Resolve their
  // email from the Person record instead of downgrading them. (#50)
  if (session?.personId) {
    const person = await prisma.person.findFirst({
      where: { id: session.personId, status: "ACTIVE" },
      select: { contactEmail: true },
    });
    if (person?.contactEmail) {
      return { email: person.contactEmail.toLowerCase(), personId: session.personId, firstName: session.applicantFirstName ?? null };
    }
  }
  const store = await cookies();
  const email = readApplicantCookie(store.get(APPLICANT_COOKIE)?.value);
  return email ? { email, personId: null, firstName: null } : null;
}

// ---------------------------------------------------------------------------
// Magic-link request (rate-limited)
// ---------------------------------------------------------------------------

import { queueEmail } from "@/platform/email/send";
import { clientIpForRateLimit } from "@/platform/auth/client-ip";
import { log } from "@/platform/logging";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { getSetting } from "@/platform/settings/service";
import { safeNextPath, PORTAL_HOME } from "./portal-next";
import { pickPortalEmailBase } from "./portal-routing";

const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_MAX = 3; // per identical email address
const DAY_MS = 24 * 60 * 60 * 1000;

// Coarse abuse backstops for this PUBLIC, unauthenticated send endpoint. The
// per-email limit alone does nothing against a script iterating distinct victim
// addresses, so add: (1) a best-effort per-IP sliding window (in-memory, per
// serverless instance) to blunt a single-source flood, and (2) a HARD global daily
// ceiling so a distributed flood can never exhaust the shared mailbox's Exchange
// send limits and silently break ALL app email. A Vercel WAF rate rule on POST
// /apply + /login is the recommended additional edge layer (see the audit).
const IP_RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const IP_RATE_MAX = 5; // per client IP per window
const GLOBAL_DAILY_MAX = 800; // portal links issued / 24h across all requesters
/**
 * Per-address share of that daily budget, and the reason the budget is no longer
 * something one requester can eat.
 *
 * RATE_MAX alone permits 3 links every 15 minutes = 288/day for a SINGLE address,
 * i.e. more than a third of GLOBAL_DAILY_MAX; three addresses exhausted it
 * outright and then every real applicant's sign-in link was silently dropped for
 * 24 hours, with nothing user-visible to explain it (audit 14, UNAUTH-01). Ten a
 * day is far beyond any honest "resend it, I lost the first one" loop and caps
 * one requester at ~1% of the shared budget.
 */
const EMAIL_DAILY_MAX = 10; // portal links issued / 24h per email address
const ipHits = new Map<string, number[]>();

function ipRateLimited(ip: string | null): boolean {
  if (!ip) return false; // no forwarded IP -> rely on per-email + global caps
  const now = Date.now();
  // Bound the map so a churn of IPs can't grow it without limit on a warm instance.
  if (ipHits.size > 5000) ipHits.clear();
  const recent = (ipHits.get(ip) ?? []).filter((t) => t > now - IP_RATE_WINDOW_MS);
  if (recent.length >= IP_RATE_MAX) {
    ipHits.set(ip, recent);
    return true;
  }
  recent.push(now);
  ipHits.set(ip, recent);
  return false;
}

/** Issue a magic-link token and email it, unless the email has already been
 *  sent RATE_MAX links in the last window (silently skip to avoid spam).
 *  `next` is the deep-link the applicant was headed to before signing in; when
 *  it is a safe same-origin path it is threaded into the verify URL so the
 *  post-sign-in redirect lands on that form rather than the portal home. */
export async function requestMagicLink(email: string, next?: string | null): Promise<void> {
  const emailLower = email.trim().toLowerCase();
  const hdrs = await headers();

  // Per-IP backstop (best-effort, per-instance). Silently skip when limited --
  // no oracle to callers. See clientIpForRateLimit for why the IP is read from
  // the right-hand end of the forwarded chain and not the left.
  if (ipRateLimited(clientIpForRateLimit(hdrs))) return;

  const recent = await prisma.applicantPortalToken.count({
    where: { emailLower, createdAt: { gt: new Date(Date.now() - RATE_WINDOW_MS) } },
  });
  if (recent >= RATE_MAX) return;

  // Per-address daily ceiling, checked BEFORE the global one so no single
  // requester can walk the shared budget down for everybody else. See
  // EMAIL_DAILY_MAX.
  const recentForEmail = await prisma.applicantPortalToken.count({
    where: { emailLower, createdAt: { gt: new Date(Date.now() - DAY_MS) } },
  });
  if (recentForEmail >= EMAIL_DAILY_MAX) {
    log.warn("[portal-auth] Daily magic-link ceiling reached for this address; skipping send.", {
      recentForEmail,
    });
    return;
  }

  // Hard global daily ceiling: bounds total outbound so a distributed flood can't
  // exhaust the shared mailbox and silently break ALL app email (member logins,
  // reminders, notifications). Legit clinic volume is far below this, and with
  // the per-address cap in front of it reaching this line now takes 80+ distinct
  // addresses rather than three.
  const globalRecent = await prisma.applicantPortalToken.count({
    where: { createdAt: { gt: new Date(Date.now() - DAY_MS) } },
  });
  if (globalRecent >= GLOBAL_DAILY_MAX) {
    log.warn("[portal-auth] Global daily magic-link ceiling reached; skipping send.", { globalRecent });
    return;
  }

  const raw = await issueMagicToken(emailLower);
  // Pick the base URL for the emailed link between two trusted, configured values:
  // the portal subdomain when the applicant is verifiably ON it, else the hub base.
  // The request Host is only compared for equality against the known portal host,
  // never interpolated, so a spoofed Host cannot point the link elsewhere. This
  // keeps the applicant's cookie (set by /apply/verify) on the host they are using.
  const appBase = await getSetting<string>("app.baseUrl");
  const requestHost = hdrs.get("host");
  const baseUrl = pickPortalEmailBase(requestHost, config.PORTAL_BASE_URL, appBase);
  // Only append next when it resolves to a real deep link (not the home default),
  // keeping the common "sign in from the portal home" link clean. The verify
  // route re-validates before redirecting, so this is defence in depth.
  const safeNext = next ? safeNextPath(next) : PORTAL_HOME;
  const nextParam = safeNext === PORTAL_HOME ? "" : `&next=${encodeURIComponent(safeNext)}`;
  const url = `${baseUrl}/apply/verify?token=${encodeURIComponent(raw)}${nextParam}`;
  const mail = await renderEmail("recruitment.portal_link", { firstName: "there", portalUrl: url });
  await queueEmail(prisma, { to: emailLower, subject: mail.subject, html: mail.html, template: "recruitment.portal_link" });
}
