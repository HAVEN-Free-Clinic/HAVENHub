import { z } from "zod";
import { isDbUnreachableError, prisma } from "@/platform/db";
import { getActivePerson } from "@/platform/auth/match-person";
import { isWebhookConfigured, intercomWebhookSecret } from "@/platform/intercom/config";
import { verifyIntercomWebhookSignature } from "@/platform/intercom/webhooks";
import { resolveIdentityFromConversation } from "@/platform/intercom/identity";
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
    // rawJson, not the parsed envelope, is handed to the refusal diagnostic --
    // see describeRawPayload for why the parsed one cannot answer the question
    // that branch exists to answer.
    return handleTicketStateUpdated(data.item ?? {}, extractEventTimestamp(parsed.data, data.item), rawJson);
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
  // Declared purely so zod does not strip it: z.object() drops every key it
  // does not name, and this is the event's own timestamp, which
  // handleTicketStateUpdated's staleness guard depends on (audit 14, finding
  // 4). Optional because it is not needed to process an event, only to order
  // one against another.
  created_at: z.number().optional(),
  data: z.object({
    item: z.record(z.string(), z.unknown()).optional(),
  }),
});

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * Key-only description of the payload EXACTLY as Intercom sent it, for the
 * ticket.state.updated refusal log below.
 *
 * Reads the raw parsed JSON rather than the validated envelope, and that is the
 * whole point. WebhookEnvelopeSchema is a `z.object`, which STRIPS every key it
 * does not declare: by the time a handler runs, the envelope holds only `topic`
 * and `data`, and `data` holds only `item`. So a payload that carried the ticket
 * anywhere other than `data.item` has already had that evidence discarded, and
 * `data.item ?? {}` turns it into an empty object -- which is how the refusal
 * branch's `itemKeys` came out as an empty string, showing in PostHog as a log
 * line with nothing in its attribute map, on a branch whose entire reason to
 * exist is answering "which fields did Intercom actually send" (audit 14,
 * finding 1). Describing the raw payload instead is the only way that question
 * has an answer.
 *
 * Reports KEYS ONLY, never values: a ticket payload carries the member-authored
 * subject and description (`ticket_attributes._default_title_` /
 * `_default_description_`), and this log ships to PostHog.
 *
 * Every field is always present and never blank -- an absent object reports
 * "(absent)" and a present-but-empty one reports "(none)" -- because "Intercom
 * sent no item" and "Intercom sent an item with no keys" are different bugs
 * with different fixes, and an empty string cannot tell them apart.
 */
function describeRawPayload(rawJson: unknown): Record<string, string> {
  const describe = (value: unknown): string => {
    if (value === undefined) return "(absent)";
    if (value === null) return "(null)";
    if (typeof value !== "object" || Array.isArray(value)) return `(${typeof value})`;
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return keys.length > 0 ? keys.join(",") : "(none)";
  };

  const envelope = rawJson && typeof rawJson === "object" ? (rawJson as Record<string, unknown>) : undefined;
  const data = envelope?.data && typeof envelope.data === "object" ? (envelope.data as Record<string, unknown>) : undefined;
  const item = data?.item;

  return {
    envelopeKeys: describe(envelope),
    dataKeys: describe(data),
    itemKeys: describe(item),
    // The one field the 2.12 serialization change moved (see
    // extractTicketStateInternalLabel): its shape, in key form, is what turns
    // "the label is missing" into "Intercom nested it somewhere new" without a
    // second deploy to find out.
    ticketStateKeys: describe(
      item && typeof item === "object" ? (item as Record<string, unknown>).ticket_state : undefined
    ),
  };
}

/**
 * When the event Intercom is describing actually happened, or null when the
 * payload carries nothing usable.
 *
 * Prefers the notification envelope's own `created_at` over the ticket's
 * `updated_at`: the envelope timestamp is stamped once when Intercom builds the
 * notification and does NOT move when the same event is redelivered, which is
 * exactly the property the staleness guard needs -- a retry must compare equal
 * to its original, not look newer than it.
 *
 * Intercom's timestamps are unix SECONDS, not milliseconds. Reading one as
 * milliseconds puts every event in January 1970, which would silently disarm
 * the guard rather than break it visibly.
 */
function extractEventTimestamp(
  envelope: { created_at?: number },
  item: Record<string, unknown> | undefined
): Date | null {
  const candidates = [envelope.created_at, item?.updated_at];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return new Date(candidate * 1000);
    }
  }
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
  //
  // This is the ONE call site that opts into the email fallback. See that
  // option's doc comment for the production failure that motivated it, for the
  // Yale-domain gate it runs through, and for why the same reasoning must not
  // be carried over to the MCP tools.
  const identity = await resolveIdentityFromConversation(conversationId, {
    allowVerifiedEmailFallback: true,
  });
  if (!identity.ok) {
    // Same audit action as the from-conversation route's identical refusal,
    // and the reason still survives only there -- never in the response.
    await recordAudit({
      actorPersonId: null,
      action: "intercom_ticket_sync.unverified",
      entityType: "TechRequest",
      after: { reason: identity.reason, source: "webhook" },
    });

    // Status code decides whether Intercom redelivers, so it has to answer
    // "could this same payload ever succeed?" rather than "did we like it?".
    //
    // lookup_failed is the only reason here that a retry can fix: Intercom
    // unreachable, timed out, or a token problem. It keeps a 5xx, and Intercom
    // keeps trying.
    if (identity.reason === "lookup_failed") {
      return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }

    // Everything else is permanent for THIS payload -- the sender is not a
    // member we can attribute a ticket to, and no number of redeliveries will
    // change that. This used to return 401, which read as an auth failure it is
    // not (the signature check above is this endpoint's auth gate, and it
    // passed) and made Intercom retry forever: on 2026-08-16 a single
    // email-sourced ticket produced a permanently failing delivery that could
    // only ever fail again. Acknowledged as a deliberate no-op instead, exactly
    // like the unhandled-topic branch in POST, so Intercom's delivery dashboard
    // shows failures only where something is genuinely retryable.
    //
    // Body carries no reason. Nothing reads it -- this is server-to-server, and
    // UNIDENTIFIED_MESSAGE belongs on the from-conversation route, where Fin
    // actually says it to a member -- so there is no reason to put the
    // distinction anywhere but the audit row.
    return Response.json({ ignored: true }, { status: 200 });
  }

  try {
    const { ticket, created, linked } = await createTechRequestFromConversation(identity.personId, {
      intercomConversationId: conversationId,
      intercomTicketId: ticketId,
      category,
      subject,
      description,
    });

    // `linked` as well as `created`: a ticket Fin opened from this same
    // conversation already had a Hub number, but no Intercom Ticket existed to
    // carry it until now, so this delivery is the FIRST moment the write-back
    // is possible at all -- exactly the situation pushTicketNumber's own doc
    // comment describes. Skipping it here would leave the "Hub ticket number"
    // attribute blank on precisely the tickets that took the two-step route
    // (audit 14, SUP-1).
    if (created || linked) {
      // Attribution by the weaker evidence is worth a row of its own. The
      // ticket reads identically to a Messenger-originated one from here on, so
      // this is the only place that records the requester was matched on an
      // emailed address rather than on an id our Messenger wrote.
      //
      // Gated on `created` INSIDE the widened branch, not merged into it: a
      // back-fill is not a first creation, and the note above is explicit that a
      // redelivery must re-attribute nothing. Widening the write-back and
      // widening the attribution are different questions.
      if (created && identity.via === "verified_email") {
        await recordAudit({
          actorPersonId: null,
          action: "intercom_ticket_sync.email_attributed",
          entityType: "TechRequest",
          entityId: ticket.id,
          after: { intercomTicketId: ticketId, ticketNumber: ticket.number, requesterId: identity.personId },
        });
      }

      // Best-effort: the ticket already exists by this point, so a failed
      // write-back is a cosmetic problem, not a reason to fail the webhook.
      const pushed = await pushTicketNumber(ticketId, ticket.number);
      if (!pushed) {
        log.warn("[support] failed to write the Hub ticket number back onto the Intercom ticket", {
          ticketId,
          ticketNumber: ticket.number,
        });
      }
    }

    if (created) {
      // Alert IT exactly as the from-conversation route does, and for the
      // same reason: without this a ticket opened via Intercom's native
      // "create ticket" action reaches nobody until someone happens to look
      // at /support/all. Only on first creation -- a retry must not re-page
      // every manager, and neither must a back-fill, whose ticket was already
      // announced when Fin created it.
      const requester = await getActivePerson(identity.personId);
      if (requester) {
        await notifyTicketSubmitted(prisma, ticket, requester);
      }
    }

    return Response.json({ number: ticket.number, created, linked }, { status: 200 });
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

async function handleTicketStateUpdated(
  item: Record<string, unknown>,
  occurredAt: Date | null,
  rawJson: unknown
): Promise<Response> {
  const ticketId = asString(item.id);
  // Shared with fetchTicketState's read of the same value, deliberately: the
  // field's shape changed at API 2.12 and this handler read only the pre-2.12
  // one, so every real delivery landed on the 400 below. See
  // extractTicketStateInternalLabel for both shapes and why a webhook must
  // accept either.
  const internalLabel = extractTicketStateInternalLabel(item);
  if (!ticketId || !internalLabel) {
    // This is the branch someone debugs a silent sync from, so it names WHICH
    // of the two required fields was absent and describes the payload's own
    // shape (keys only -- see describeRawPayload) rather than restating that
    // something was missing. The four production refusals on 2026-08-13 landed
    // here and carried an empty attribute map, which is the failure audit 14
    // finding 1 is about: the diagnostic was reading the post-zod envelope,
    // where the answer no longer exists.
    log.warn("[support] ticket.state.updated webhook missing a ticket id or state label", {
      missing: !ticketId && !internalLabel ? "id+state" : !ticketId ? "id" : "state",
      ...describeRawPayload(rawJson),
    });
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const result = await applyIntercomTicketStateChange(ticketId, internalLabel, occurredAt);
  if (!result.ok) {
    // Distinct status codes so an operator scanning Intercom's webhook
    // delivery dashboard can tell the failure modes apart. 409, deliberately
    // NOT 404: this route already answers 404 for "the integration is not
    // configured", so a 404 here was indistinguishable from the webhook
    // hitting a Hub with Intercom switched off -- the two want opposite
    // responses (re-check the ticket link vs. set the env vars), and the
    // delivery dashboard shows only the status code (audit 14, finding 5).
    // 409 keeps the delivery retryable, since "we don't know this ticket" can
    // still be a delivery-ordering race against ticket.created; "we don't
    // recognize this state" (422) is a mapping gap that only a code change
    // fixes. Both are logged and audited inside applyIntercomTicketStateChange.
    const status = result.reason === "ticket_not_found" ? 409 : 422;
    return Response.json({ error: result.reason }, { status });
  }

  // A stale delivery is reported as an accepted no-op, not an error: Intercom
  // did nothing wrong sending it, and re-delivering it would produce the same
  // refusal forever.
  return Response.json(
    { ok: true, changed: result.changed, ...(result.stale ? { stale: true } : {}) },
    { status: 200 }
  );
}
