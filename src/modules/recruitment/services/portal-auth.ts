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
  const token = await prisma.applicantPortalToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  if (!token || token.usedAt || token.expiresAt < new Date()) return null;
  await prisma.applicantPortalToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
  return token.emailLower;
}
