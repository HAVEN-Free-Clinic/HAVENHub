/**
 * Intercom Messenger configuration, read from the environment.
 *
 * UNSET = the whole feature is off: the Messenger never boots, the token route
 * 404s, and no third-party script reaches the browser. That keeps dev, CI, and
 * the e2e suite free of a live support widget without a separate feature flag.
 *
 * The app id is public by design (it ships in the browser bundle and identifies
 * the workspace, not the user), so it is a NEXT_PUBLIC_ var. The Messenger
 * secret signs user JWTs and must never reach the client, so it deliberately is
 * not.
 */
export function intercomAppId(): string | null {
  return process.env.NEXT_PUBLIC_INTERCOM_APP_ID?.trim() || null;
}

export function intercomMessengerSecret(): string | null {
  return process.env.INTERCOM_MESSENGER_SECRET?.trim() || null;
}

/**
 * Both halves are required to turn the feature on. An app id without a secret
 * would boot an *unverified* Messenger, where identity is whatever the browser
 * claims -- exactly the impersonation hole identity verification exists to
 * close. A half-configured workspace therefore stays off rather than silently
 * degrading to the insecure mode.
 */
export function isIntercomConfigured(): boolean {
  return intercomAppId() !== null && intercomMessengerSecret() !== null;
}
