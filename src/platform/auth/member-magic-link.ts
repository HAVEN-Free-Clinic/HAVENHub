import { randomBytes, createHash } from "node:crypto";
import { prisma } from "@/platform/db";

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
