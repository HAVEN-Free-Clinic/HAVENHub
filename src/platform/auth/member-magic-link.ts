import { randomBytes, createHash } from "node:crypto";
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { queueEmail } from "@/platform/email/send";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { safeLoginPath } from "@/platform/auth/safe-next";

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
const RATE_MAX = 3;

function firstNameFromName(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first || "there";
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

  const recent = await prisma.memberLoginToken.count({
    where: { emailLower, createdAt: { gt: new Date(Date.now() - RATE_WINDOW_MS) } },
  });
  if (recent >= RATE_MAX) return "sent";

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
    firstName: firstNameFromName(person.name),
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
