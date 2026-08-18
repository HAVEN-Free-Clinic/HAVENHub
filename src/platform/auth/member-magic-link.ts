import { randomBytes, createHash } from "node:crypto";
import { headers } from "next/headers";
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { queueEmail } from "@/platform/email/send";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { safeLoginPath } from "@/platform/auth/safe-next";
import { clientIpForRateLimit } from "@/platform/auth/client-ip";
import { firstNameOf } from "@/platform/person-name";
import { log } from "@/platform/logging";

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const YALE_DOMAIN = "@yale.edu";

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Create a single-use member-login token bound to `personId` and return the
 *  raw token (only its hash is stored). */
export async function issueMemberToken(personId: string, email: string): Promise<string> {
  const emailLower = email.trim().toLowerCase();
  const raw = randomBytes(32).toString("base64url");
  await prisma.memberLoginToken.create({
    data: {
      emailLower,
      personId,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    },
  });
  return raw;
}

/** Validate a raw token WITHOUT consuming it. Returns the member's email + name
 *  for the confirm screen, else null. Peek-then-confirm defeats login-CSRF: a
 *  forwarded link shows whose account it signs into before the user commits. */
export async function peekMemberToken(rawToken: string): Promise<{ email: string; name: string } | null> {
  // Honor the kill switch at CONSUME time, not just at issuance (#66). Turning off
  // "Member email sign-in links" must stop outstanding (already-emailed, still
  // within the 30-min TTL) links from working, or the switch only blocks new links.
  if (!(await getSetting<boolean>("auth.memberMagicLinkEnabled"))) return null;
  const token = await prisma.memberLoginToken.findFirst({
    where: { tokenHash: hashToken(rawToken), usedAt: null, expiresAt: { gt: new Date() } },
    select: { personId: true, emailLower: true },
  });
  if (!token) return null;
  const person = await prisma.person.findFirst({
    where: { id: token.personId, status: "ACTIVE" },
    select: { name: true, contactEmail: true },
  });
  if (!person?.contactEmail || person.contactEmail.toLowerCase() !== token.emailLower) return null;
  return { email: token.emailLower, name: person.name };
}

/** Atomically claim a raw token (single-use, TOCTOU-safe) and re-check the bound
 *  member is still ACTIVE, non-Yale, and their contactEmail still matches.
 *  Returns { personId } or null. */
export async function verifyAndConsumeMemberToken(rawToken: string): Promise<{ personId: string } | null> {
  // Re-check the kill switch here, not just at issuance (#66): a link emailed
  // before the admin turned member sign-in off must not still mint a 7-day session.
  if (!(await getSetting<boolean>("auth.memberMagicLinkEnabled"))) return null;
  const tokenHash = hashToken(rawToken);
  // The WHERE clause matches only an unused, unexpired row; a row-level lock
  // means exactly one concurrent caller flips usedAt, closing the TOCTOU race.
  const claimed = await prisma.memberLoginToken.updateMany({
    where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) return null;
  const token = await prisma.memberLoginToken.findUnique({
    where: { tokenHash },
    select: { personId: true, emailLower: true },
  });
  if (!token || token.emailLower.endsWith(YALE_DOMAIN)) return null;
  const person = await prisma.person.findFirst({
    where: { id: token.personId, status: "ACTIVE" },
    select: { id: true, contactEmail: true },
  });
  if (!person?.contactEmail || person.contactEmail.toLowerCase() !== token.emailLower) return null;
  return { personId: person.id };
}

const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_MAX = 3; // per identical email address

// Coarse abuse backstops for this PUBLIC, unauthenticated send endpoint, mirroring
// the applicant portal (portal-auth.ts): the per-email limit alone does nothing
// against a script iterating distinct victim member addresses. (1) a best-effort
// per-IP sliding window (in-memory, per serverless instance) to blunt a single-
// source flood; (2) a HARD global daily ceiling so a distributed flood can't
// exhaust the shared clinic mailbox's Exchange send limits and silently break ALL
// app email. Both endpoints drain the same mailbox. (#121)
const IP_RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const IP_RATE_MAX = 5; // per client IP per window
const GLOBAL_DAILY_MAX = 800; // member links issued / 24h across all requesters
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Per-address share of that daily budget. Same defect and same reasoning as the
 * applicant portal's EMAIL_DAILY_MAX (audit 14, UNAUTH-01): RATE_MAX alone lets a
 * single address consume 288 of the 800, so a handful of addresses exhausted the
 * ceiling and every non-Yale member lost their only way into the hub for 24
 * hours, silently. Both endpoints drain the same mailbox, so both need the cap.
 */
const EMAIL_DAILY_MAX = 10; // member links issued / 24h per email address
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

export type MemberLinkRequest = "sent" | "use-yale" | "disabled";

/** Guarded issuer: honors the kill-switch, refuses Yale addresses, rate-limits,
 *  resolves an ACTIVE Person by contactEmail, and emails a one-time
 *  /login/verify link. Returns "sent" for a match, a non-match, AND a
 *  rate-limited request, so it never reveals whether an email is a member. */
export async function requestMemberLoginLink(email: string, next?: string | null): Promise<MemberLinkRequest> {
  const enabled = await getSetting<boolean>("auth.memberMagicLinkEnabled");
  if (!enabled) return "disabled";

  const emailLower = email.trim().toLowerCase();
  if (emailLower.endsWith(YALE_DOMAIN)) return "use-yale";

  // Per-IP backstop (best-effort, per-instance). Silently "sent" when limited --
  // no membership oracle to callers (#121). See clientIpForRateLimit for why the
  // IP is read from the right-hand end of the forwarded chain and not the left.
  if (ipRateLimited(clientIpForRateLimit(await headers()))) return "sent";

  const recent = await prisma.memberLoginToken.count({
    where: { emailLower, createdAt: { gt: new Date(Date.now() - RATE_WINDOW_MS) } },
  });
  if (recent >= RATE_MAX) return "sent";

  // Per-address daily ceiling, checked BEFORE the global one so no single
  // requester can walk the shared budget down for every other member.
  const recentForEmail = await prisma.memberLoginToken.count({
    where: { emailLower, createdAt: { gt: new Date(Date.now() - DAY_MS) } },
  });
  if (recentForEmail >= EMAIL_DAILY_MAX) {
    log.warn("[member-magic-link] Daily member-link ceiling reached for this address; skipping send.", {
      recentForEmail,
    });
    return "sent";
  }

  // Hard global daily ceiling: bound total member links/24h so a distributed flood
  // across many addresses can't exhaust the shared mailbox and silently break ALL
  // app email. Legit clinic volume is far below this. (#121)
  const globalRecent = await prisma.memberLoginToken.count({
    where: { createdAt: { gt: new Date(Date.now() - DAY_MS) } },
  });
  if (globalRecent >= GLOBAL_DAILY_MAX) {
    log.warn("[member-magic-link] Global daily member-link ceiling reached; skipping send.", { globalRecent });
    return "sent";
  }

  const person = await prisma.person.findFirst({
    where: { contactEmail: { equals: emailLower, mode: "insensitive" }, status: "ACTIVE" },
    select: { id: true, name: true, contactEmail: true },
  });
  // Silent no-op: never reveal whether an email maps to an active member.
  if (!person?.contactEmail || person.contactEmail.toLowerCase().endsWith(YALE_DOMAIN)) {
    return "sent";
  }

  const raw = await issueMemberToken(person.id, emailLower);
  const base = await getSetting<string>("app.baseUrl");
  const safeNext = safeLoginPath(next);
  const nextParam = safeNext === "/" ? "" : `&next=${encodeURIComponent(safeNext)}`;
  const loginUrl = `${base}/login/verify?token=${encodeURIComponent(raw)}${nextParam}`;
  const mail = await renderEmail("auth.member_login_link", {
    firstName: firstNameOf(person.name) || "there",
    loginUrl,
  });
  await queueEmail(prisma, {
    to: person.contactEmail,
    subject: mail.subject,
    html: mail.html,
    template: "auth.member_login_link",
    personId: person.id,
  });
  return "sent";
}
