import { z } from "zod";
import { isDbUnreachableError, prisma } from "@/platform/db";
import { getActivePerson } from "@/platform/auth/match-person";
import { isWebhookConfigured, intercomWebhookSecret } from "@/platform/intercom/config";
import { verifyIntercomWebhookSignature } from "@/platform/intercom/webhooks";
import { resolveIdentityFromConversation, UNIDENTIFIED_MESSAGE } from "@/platform/intercom/identity";
import { extractTicketStateInternalLabel, pushTicketNumber } from "@/platform/intercom/tickets";
import { recordAudit } from "@/platform/audit";
import { log, errorAttrs } from "@/platform/logging";
import { createTechRequestFromConversation, SupportStateError } from "@/modules/support/services/tech-request";
import { notifyTicketSubmitted } from "@/modules/support/services/notifications";
import {
  applyIntercomTicketStateChange,
  mapIntercomTicketTypeToCategory,
} from "@/modules/support/services/intercom-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/support/tickets/events
 *
 * Receives Intercom's ticket webhooks -- the inbound halves of Directions 1
 * and 3 of the Intercom <-> TechRequest sync (see
 * docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md):
 * ticket.created opens the Hub record, ticket.state.updated updates its
 * status. One endpoint for both, per the design ("Same signature
 * verification, same origin tagging, one endpoint").
 *
 * Deliberately does NOT contain the word "intercom" in its path, for the
 * same reason as MESSENGER_TOKEN_PATH (src/platform/intercom/messenger.tsx)
 * and the from-conversation route: mainstream ad blockers match on URL
 * substrings. This route is only ever called server-to-server by Intercom's
 * webhook delivery, so no browser loads it directly, but there is no reason
 * to invite the problem.
 *
 * Auth is signature-based, not bearer: Intercom does not let a webhook
 * subscription attach a custom Authorization header the way Fin's custom
 * action can, so the only proof a request actually came from Intercom is its
 * `X-Hub-Signature` header (see verifyIntercomWebhookSignature). This is
 * checked FIRST, against the raw body, before the body is parsed or a
 * database row touched -- this endpoint is an unauthenticated-by-default
 * write path into ticket status, so anyone who found the URL could otherwise
 * move a ticket's status by hand.
 */
export async function POST(request: Request): Promise<Response> {
  // Feature off looks like the route does not exist, same posture as every
  // other Intercom-facing route in this codebase: never advertise a
  // half-configured integration.
  if (!isWebhookConfigured()) {
    return Response.json({ error: "Not Found" }, { status: 404 });
  }

  // Read the raw bytes BEFORE any parsing: Intercom signs the exact body it
  // sent, and re-serializing a JSON.parse'd object would produce a different
  // HMAC and reject every legitimate request. See verifyIntercomWebhookSignature's
  // doc comment.
  const rawBody = await request.text();
  const secret = intercomWebhookSecret();
  const signatureHeader = request.headers.get("x-hub-signature");
  if (!secret || !verifyIntercomWebhookSignature(rawBody, signatureHeader, secret)) {
    log.warn("[support] rejected an Intercom webhook with a missing or invalid signature");
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawBody);
  } catch {
    log.warn("[support] rejected an Intercom webhook with an unparseable body");
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const parsed = WebhookEnvelopeSchema.safeParse(rawJson);
  if (!parsed.success) {
    log.warn("[support] rejected a validly-signed Intercom webhook with an unexpected shape");
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { topic, data } = parsed.data;

  if (topic === "ticket.created") {
    return handleTicketCreated(data.item ?? {});
  }
  if (topic === "ticket.state.updated") {
    return handleTicketStateUpdated(data.item ?? {});
  }

  // Any other topic Intercom might send (its webhook-setup connectivity
  // check, or a topic we are subscribed to but do not act on) is
  // acknowledged, not rejected, so Intercom's delivery dashboard does not
  // show a permanent failure for traffic this endpoint was never meant to
  // process.
  log.info("[support] ignoring unhandled Intercom webhook topic", { topic });
  return Response.json({ ignored: true }, { status: 200 });
}

/**
 * Deliberately loose on `item`: its shape varies by topic and this codebase
 * has not verified every field name against a live workspace (see the
 * webhook report's open questions). Each handler below extracts only the
 * specific fields it needs and defensively type-guards them, rather than
 * trusting a rigid schema that would reject a legitimate payload over an
 * unrelated field this endpoint does not use.
 *
 * `item` is optional, not required: requiring it meant the 200-and-ignore
 * branch below (for a topic this endpoint does not act on) could only be
 * reached AFTER a payload with an item parsed -- so anything without one,
 * including Intercom's own subscription-verification ping, 400'd instead of
 * being ignored, and showed as a permanent failure in Intercom's delivery
 * dashboard for traffic this endpoint was never meant to handle. The two
 * handlers that DO need item (handleTicketCreated, handleTicketStateUpdated)
 * are unaffected: each already treats a missing field it needs (ticket id,
 * state label) as an ordinary 400, so an item-less ticket.created or
 * ticket.state.updated -- which is not a real Intercom payload -- still fails
 * the same way, just via that per-field check instead of the schema.
 */
const WebhookEnvelopeSchema = z.object({
  topic: z.string(),
  data: z.object({
    item: z.record(z.string(), z.unknown()).optional(),
  }),
});

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

// ---------------------------------------------------------------------------
// ticket.created
// ---------------------------------------------------------------------------

async function handleTicketCreated(item: Record<string, unknown>): Promise<Response> {
  // The Intercom ticket id, per Intercom's own guidance: "id" is the object's
  // canonical identifier used across every API call; "ticket_id" is only the
  // human-readable number shown in Intercom's own Inbox/Messenger UI, and is
  // documented as unusable for API operations. A ticket created via Intercom's
  // "convert this conversation to a ticket" action keeps the same id as the
  // conversation it came from (the endpoint is literally
  // POST /conversations/{id}/convert -- a conversion in place, not a new
  // object), which is why the SAME value is used below for both
  // intercomConversationId and intercomTicketId.
  //
  // VERIFIED against the live workspace on 2026-08-12, not taken from the docs:
  // ticket id 215475452769278 (ticket_id 124067269, the human-readable number)
  // fetched as GET /conversations/215475452769278 returns 200 with
  // type: "conversation" and the identical id, carrying exactly one contact
  // whose external_id is a Person cuid. That is every link this handler depends
  // on. Note the two ids are wildly different in shape -- 215475452769278 vs
  // 124067269 -- so using "ticket_id" here would not merely be wrong, it would
  // fail to resolve as a conversation at all.
  const ticketId = asString(item.id);
  if (!ticketId) {
    log.warn("[support] ticket.created webhook missing a ticket id");
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
  const conversationId = ticketId;

  const attrs = (item.ticket_attributes && typeof item.ticket_attributes === "object"
    ? (item.ticket_attributes as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const subject = asString(attrs["_default_title_"]) ?? "";
  const description = asString(attrs["_default_description_"]) ?? "";
  const ticketTypeName = extractTicketTypeName(item);
  const category = mapIntercomTicketTypeToCategory(ticketTypeName);

  // Identity comes ONLY from the conversation, via the exact same verified
  // lookup every other Intercom-facing write in this codebase uses -- never
  // from any contact/requester-shaped field on the webhook payload itself.
  // This path writes a TechRequest, so a value trusted from the payload
  // would let a forged requester file a ticket as somebody else.
  const identity = await resolveIdentityFromConversation(conversationId);
  if (!identity.ok) {
    // Same audit action and same undifferentiated message as the
    // from-conversation route's identical refusal -- see that route's doc
    // comment for why the caller never learns which of the underlying
    // reasons applied.
    await recordAudit({
      actorPersonId: null,
      action: "intercom_ticket_sync.unverified",
      entityType: "TechRequest",
      after: { reason: identity.reason, source: "webhook" },
    });
    return Response.json({ error: UNIDENTIFIED_MESSAGE }, { status: 401 });
  }

  try {
    const { ticket, created } = await createTechRequestFromConversation(identity.personId, {
      intercomConversationId: conversationId,
      intercomTicketId: ticketId,
      category,
      subject,
      description,
    });

    if (created) {
      // Best-effort: the ticket already exists by this point, so a failed
      // write-back is a cosmetic problem, not a reason to fail the webhook.
      const pushed = await pushTicketNumber(ticketId, ticket.number);
      if (!pushed) {
        log.warn("[support] failed to write the Hub ticket number back onto the Intercom ticket", {
          ticketId,
          ticketNumber: ticket.number,
        });
      }

      // Alert IT exactly as the from-conversation route does, and for the
      // same reason: without this a ticket opened via Intercom's native
      // "create ticket" action reaches nobody until someone happens to look
      // at /support/all. Only on first creation -- a retry must not re-page
      // every manager.
      const requester = await getActivePerson(identity.personId);
      if (requester) {
        await notifyTicketSubmitted(prisma, ticket, requester);
      }
    }

    return Response.json({ number: ticket.number, created }, { status: 200 });
  } catch (err) {
    if (isDbUnreachableError(err)) {
      log.warn("[support] database unreachable creating ticket from Intercom webhook", errorAttrs(err));
      return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
    if (err instanceof SupportStateError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

function extractTicketTypeName(item: Record<string, unknown>): string | null {
  const ticketType = item.ticket_type;
  if (ticketType && typeof ticketType === "object" && "name" in ticketType) {
    return asString((ticketType as Record<string, unknown>).name);
  }
  return null;
}

// ---------------------------------------------------------------------------
// ticket.state.updated
// ---------------------------------------------------------------------------

async function handleTicketStateUpdated(item: Record<string, unknown>): Promise<Response> {
  const ticketId = asString(item.id);
  // Shared with fetchTicketState's read of the same value, deliberately: the
  // field's shape changed at API 2.12 and this handler read only the pre-2.12
  // one, so every real delivery landed on the 400 below. See
  // extractTicketStateInternalLabel for both shapes and why a webhook must
  // accept either.
  const internalLabel = extractTicketStateInternalLabel(item);
  if (!ticketId || !internalLabel) {
    // Logs the keys, never the values: this is the branch someone debugs a
    // silent sync from, and "which fields did Intercom actually send" is the
    // one question the old message could not answer. Ticket payloads carry
    // member-authored subject and description text, so the keys are the most
    // that can be logged here.
    log.warn("[support] ticket.state.updated webhook missing a ticket id or state label", {
      itemKeys: Object.keys(item).sort().join(","),
    });
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const result = await applyIntercomTicketStateChange(ticketId, internalLabel);
  if (!result.ok) {
    // Distinct status codes so an operator scanning Intercom's webhook
    // delivery dashboard can tell the two failure modes apart: "we don't
    // know this ticket" may be a delivery-ordering race that redelivery
    // resolves on its own, while "we don't recognize this state" is a
    // mapping gap that only a code change fixes -- redelivery will not help.
    // Both are logged inside applyIntercomTicketStateChange with the detail.
    const status = result.reason === "ticket_not_found" ? 404 : 422;
    return Response.json({ error: result.reason }, { status });
  }

  return Response.json({ ok: true, changed: result.changed }, { status: 200 });
}
