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

/**
 * The app id to mount the Messenger with, or null when the integration is off.
 * Every mount site (the (app) layout, /apply, /login, /onboard, /get-started,
 * /welcome) needs exactly this "configured ? id : null" check before rendering
 * IntercomMessenger, so it lives here once rather than being re-derived at each
 * call site.
 */
export function resolveSupportAppId(): string | null {
  return isIntercomConfigured() ? intercomAppId() : null;
}

/**
 * Access token for Intercom's REST API, used to verify that a claimed Person id
 * really belongs to the contact in the conversation. Without it the MCP server
 * would have to take the caller's word for who they are, so its absence turns
 * the whole endpoint off.
 */
export function intercomAccessToken(): string | null {
  return process.env.INTERCOM_ACCESS_TOKEN?.trim() || null;
}

/** Shared secret Fin presents to the MCP endpoint. Absent = endpoint off. */
export function mcpBearerToken(): string | null {
  return process.env.INTERCOM_MCP_BEARER_TOKEN?.trim() || null;
}

/**
 * The MCP endpoint requires the Messenger to be configured as well: identity
 * originates in the Messenger JWT, so an MCP server without it would be
 * verifying contacts whose user_id nothing ever signed.
 */
export function isMcpConfigured(): boolean {
  return isIntercomConfigured() && intercomAccessToken() !== null && mcpBearerToken() !== null;
}

/**
 * Shared secret used to verify Intercom's `X-Hub-Signature` header on the
 * inbound ticket-sync webhook -- the app's client secret (Settings > Basic
 * Info), NOT the API access token above. Two different credentials with two
 * different blast radii: the access token reads/writes through Intercom's
 * REST API, while this one only proves a request body was actually signed by
 * Intercom. Absent = the webhook receiver 404s, same "unset = feature off"
 * posture as the rest of this file.
 */
export function intercomWebhookSecret(): string | null {
  return process.env.INTERCOM_WEBHOOK_SECRET?.trim() || null;
}

/**
 * The webhook receiver also requires the access token: ticket.created
 * resolves identity (resolveIdentityFromConversation) and writes the Hub
 * ticket number back (pushTicketNumber), both through the same REST API
 * postConversationNote already uses. A webhook secret without it would 401
 * every signature check successfully and then fail every ticket.created,
 * which is a worse failure mode than staying off.
 *
 * Also chains through isIntercomConfigured, same reasoning as isMcpConfigured
 * just above: resolveIdentityFromConversation only ever finds a contact by
 * the external_id the Messenger's identity-verified boot sets, so a webhook
 * receiver live without the Messenger would 401 every ticket.created
 * forever, with nothing to fix it short of configuring the Messenger anyway.
 * That is a partially-configured state that fails obscurely rather than
 * staying off -- the exact posture every function in this file avoids.
 */
export function isWebhookConfigured(): boolean {
  return isIntercomConfigured() && intercomWebhookSecret() !== null && intercomAccessToken() !== null;
}

/**
 * Deep link into Intercom's own agent inbox for a conversation, for staff who
 * work the conversation in Intercom rather than in the Hub (see "Where the
 * work happens" in docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md).
 * Returns null when the app id is unset, so a caller renders no link rather
 * than guessing at a URL for a workspace that may not even exist -- the same
 * "unset = feature off" posture as the rest of this file.
 */
export function intercomConversationUrl(conversationId: string): string | null {
  const appId = intercomAppId();
  if (!appId) return null;
  return `https://app.intercom.com/a/inbox/${appId}/inbox/conversation/${conversationId}`;
}

/**
 * The Intercom admin a HAVEN Hub status-change note is authored as. Intercom
 * requires an admin_id on every reply to a conversation, notes included --
 * there is no default or "system" author it will fall back to -- so posting is
 * impossible without one. A dedicated bot/workflow admin in the workspace
 * (rather than a real staff member's id) keeps the author stable regardless of
 * who is on the IT team this term. Absent = the outbound conversation sync is
 * off, same "unset = feature off" posture as the rest of this file.
 */
export function intercomBotAdminId(): string | null {
  return process.env.INTERCOM_BOT_ADMIN_ID?.trim() || null;
}
