import { createHmac } from "node:crypto";
import { constantTimeEqual } from "@/platform/security";

const SIGNATURE_PREFIX = "sha1=";

/**
 * Verifies Intercom's `X-Hub-Signature` header on an inbound webhook request:
 * an HMAC-SHA1 of the RAW request body, hex-encoded, keyed by the app's
 * client secret (see intercomWebhookSecret's doc comment for why that secret
 * and not the API access token).
 *
 * This must run before anything else in the webhook route. The receiver is
 * an unauthenticated-by-default write path into ticket status -- see
 * docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md's
 * Security section -- so an unsigned or mis-signed request is refused before
 * the body is ever parsed or a database row touched, never merely logged
 * after the fact.
 *
 * Takes the raw body string, not a parsed object: Intercom signs the exact
 * bytes it sent, and re-serializing a JSON.parse'd object (different key
 * order, different whitespace) would produce a different HMAC and reject
 * every legitimate request. Callers must read the request body with
 * request.text() and pass that verbatim, before ever calling JSON.parse.
 *
 * Comparison is constant-time (constantTimeEqual, shared with every other
 * secret comparison in this codebase) so a forged signature cannot be
 * recovered byte-by-byte via response-timing differences the way a naive
 * `===` would allow.
 *
 * SHA-1 here is not a choice, and not a weakness. Intercom signs with
 * HMAC-SHA1 and sends a `sha1=` prefix; it offers no SHA-256 variant, and
 * their docs call this out explicitly ("match the algorithm exactly or the
 * digest will never line up"). Verification must use whatever the sender
 * used.
 *
 * A static analyser will flag `createHmac("sha1", ...)` on a generic
 * "SHA-1 is broken" rule -- CodeQL raised exactly this as High on the PR
 * that added this file. The rule does not distinguish HMAC from raw
 * hashing, and the distinction is the whole point: SHA-1's practical break
 * is COLLISION resistance, which HMAC's security does not rest on. HMAC-SHA1
 * remains sound for message authentication and is still permitted by NIST
 * for it.
 *
 * The suggested remediation -- accept `sha256=` and fall back to `sha1=` --
 * should not be applied. The SHA-256 branch could never execute, because
 * Intercom never sends that prefix, and it would make the digest algorithm
 * selectable by an attacker-controlled header for no gain. If Intercom ever
 * does add SHA-256, switch to it outright rather than accepting both.
 */
export function verifyIntercomWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!signatureHeader) return false;
  const digest = createHmac("sha1", secret).update(rawBody, "utf8").digest("hex");
  return constantTimeEqual(signatureHeader, `${SIGNATURE_PREFIX}${digest}`);
}
