import { createHash } from "node:crypto";

/**
 * A stable encryption key for Next's Server Actions, so a form rendered by one
 * deploy still works after the next one.
 *
 * ---------------------------------------------------------------------------
 * The failure this exists to stop
 * ---------------------------------------------------------------------------
 *
 * Members were locked out at `/login` by
 * `UnrecognizedActionError: Server Action "<id>" was not found on the server`.
 * Error Tracking recorded 10 of them across 6 people (2026-08-28 to 08-31),
 * every one on `hub.havenfreeclinic.org/login`, with people visibly retrying two
 * seconds apart into the same wall.
 *
 * The cause is not the login page. It is that EVERY Server Action id in the app
 * changes whenever Next regenerates its encryption key:
 *
 *   - `build/index.js` calls `generateEncryptionKeyBase64()` for each build.
 *   - `webpack-config.js` passes that key straight through as
 *     `serverReferenceHashSalt`, which `build/swc/options.js` hands the compiler
 *     as `hashSalt`.
 *   - The action id is a hash over that salt plus the module path and export
 *     name. New salt, new id -- for every action, all at once.
 *
 * Without `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` set, that key is a random
 * AES-256 key. Next caches it in `.next/cache/.rscinfo`, but the cache lasts 14
 * days, is dropped whenever the build cache misses, and
 * `getStorageDirectory()` returns nothing at all inside a container it judges
 * ephemeral -- so on a hosted builder it can be freshly random on every deploy.
 *
 * That is why this arrived in bursts rather than on a schedule, and why `/login`
 * took nearly all of it: a sign-in page is the tab people leave parked longest,
 * so it is the likeliest to still be holding a bundle from before the rotation.
 *
 * ---------------------------------------------------------------------------
 * Why derive it instead of adding a secret
 * ---------------------------------------------------------------------------
 *
 * Setting `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` explicitly is the documented fix
 * and is still honoured first (see `pinServerActionsEncryptionKey`). But a fix
 * that only works once somebody provisions a new secret in every environment is
 * a fix that stays unapplied, and the environments that most need it (preview,
 * staging) are the ones most likely to be missed.
 *
 * `AUTH_SECRET` is already required everywhere the app runs, already the output
 * of `openssl rand -base64 32`, and already rotated deliberately rather than
 * incidentally. Deriving from it with a domain separator gives every environment
 * a stable key with nothing to provision.
 *
 * The trade: rotating `AUTH_SECRET` also rotates every action id, so tabs open
 * across that rotation break once. That is what happens today on an ordinary
 * deploy, so this turns a recurring failure into a rare and deliberate one --
 * and rotating `AUTH_SECRET` already signs every member out anyway.
 *
 * The client self-heal (`src/platform/posthog/stale-server-action.ts`) stays
 * exactly as it is. It is the recovery for the window this cannot close: a tab
 * that predates a genuine change to the action itself. Prevention here, recovery
 * there -- neither replaces the other.
 */

/**
 * Domain separator. Keeps this derivation from ever colliding with another use
 * of `AUTH_SECRET`, and lets the key be rotated on its own by bumping `v1` if it
 * is ever needed.
 */
const DERIVATION_SALT = "havenhub/next-server-actions-encryption-key/v1";

/**
 * Derive the base64 AES-256 key Next expects from an arbitrary secret.
 *
 * A SHA-256 digest is exactly the 32 raw bytes AES-GCM-256 requires, so this is
 * a valid key for any input -- `AUTH_SECRET` has no enforced length or encoding
 * beyond being non-empty, and a key of the wrong size would fail `importKey` and
 * take every Server Action in the app down with it.
 */
export function deriveServerActionsEncryptionKey(secret: string): string {
  return createHash("sha256").update(`${DERIVATION_SALT}:${secret}`).digest("base64");
}

/**
 * Pin the key into the environment for the build about to run.
 *
 * Called from `next.config.ts`, which Next loads before it generates the build's
 * encryption key. Returns what it did so the caller can say so out loud.
 *
 * Deliberately silent about the value itself: it is a derived secret and must
 * never reach a build log.
 */
export function pinServerActionsEncryptionKey(
  // Deliberately not NodeJS.ProcessEnv: Next augments that type with required
  // keys, which would force every test to build a whole environment to assert
  // one branch. process.env satisfies this.
  env: Record<string, string | undefined> = process.env,
): "explicit" | "derived" | "unavailable" {
  // An explicit key always wins: someone who set it has a reason, and silently
  // overriding it would break exactly the multi-instance case it was set for.
  if (env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY) return "explicit";

  // No AUTH_SECRET means this is not a real build of the app (config.ts refuses
  // to boot without one). Leave Next to its random key rather than inventing a
  // constant that would be shared by every checkout on earth.
  const authSecret = env.AUTH_SECRET;
  if (!authSecret) return "unavailable";

  env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY = deriveServerActionsEncryptionKey(authSecret);
  return "derived";
}
