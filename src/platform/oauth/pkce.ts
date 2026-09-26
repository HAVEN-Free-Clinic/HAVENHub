import { createHash } from "node:crypto";
import { constantTimeEqual } from "@/platform/security";

/**
 * RFC 7636 S256: base64url(sha256(verifier)) must equal the challenge the
 * client sent at authorize. The only method this server accepts; "plain" would
 * let whoever intercepts the code redeem it.
 */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  // RFC 7636 section 4.1: 43-128 unreserved characters. Rejecting a malformed
  // verifier up front keeps a garbage value from ever reaching the comparison.
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return constantTimeEqual(computed, challenge);
}

/** A well-formed S256 challenge is 43 base64url characters (a sha256 digest). */
export function isValidChallenge(challenge: string): boolean {
  return /^[A-Za-z0-9\-_]{43}$/.test(challenge);
}
