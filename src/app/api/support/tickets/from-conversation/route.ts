import { z } from "zod";
import type { TechRequestCategory } from "@prisma/client";
import { isDbUnreachableError, prisma } from "@/platform/db";
import { getActivePerson } from "@/platform/auth/match-person";
import { isMcpConfigured, mcpBearerToken } from "@/platform/intercom/config";
import { resolveIdentityFromConversation, UNIDENTIFIED_MESSAGE } from "@/platform/intercom/identity";
import { constantTimeBearerMatch } from "@/platform/security";
import { recordAudit } from "@/platform/audit";
import { log, errorAttrs } from "@/platform/logging";
import { createTechRequestFromConversation, SupportStateError } from "@/modules/support/services/tech-request";
import { notifyTicketSubmitted } from "@/modules/support/services/notifications";
import { ALL_CATEGORIES } from "@/modules/support/filter-options";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Only category, subject, and description -- no Epic-specific field (e.g.
 * epicSubtype) and no requesterId. zod strips unrecognized keys by default
 * (this object is never `.passthrough()`d), so any of those riding along in
 * a request body is dropped before parsing even finishes -- structurally
 * unable to reach createTechRequestFromConversation, not merely unused by it.
 * The requester travels a completely separate path (resolveIdentityFromConversation
 * below), never this schema, which is what keeps a forged body from filing a
 * ticket as somebody else.
 */
const RequestSchema = z.object({
  conversationId: z.string().trim().min(1),
  category: z.enum(ALL_CATEGORIES as [TechRequestCategory, ...TechRequestCategory[]]),
  subject: z.string(),
  description: z.string(),
});

/**
 * POST /api/support/tickets/from-conversation
 *
 * Inbound half of the Intercom <-> TechRequest sync (see
 * docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md). Lets a
 * member who only ever talked to Fin in the Messenger still end up with a
 * real Hub ticket, a number to quote, and an audit trail -- rather than a
 * conversation nobody in IT ever sees.
 *
 * Deliberately does not have "intercom" anywhere in its path. See
 * MESSENGER_TOKEN_PATH's doc comment in src/platform/intercom/messenger.tsx:
 * mainstream ad blockers match on URL substrings, and a first-party endpoint
 * named after the vendor is blocked exactly like a third-party tracker would
 * be. This route is only ever called server-to-server (Fin's custom action),
 * so no browser ever loads it directly, but there is no reason to invite the
 * problem when a neutral path costs nothing.
 *
 * Auth and identity reuse the MCP endpoint's model exactly (src/app/api/mcp/route.ts):
 * a shared bearer secret proves the caller is our Intercom connector, gated
 * behind the same isMcpConfigured() the MCP route uses (both surfaces are
 * "the Intercom connector may call the Hub" and share one on/off switch and
 * one secret). Identity is then resolved from the conversation id via
 * resolveIdentityFromConversation, exactly as every MCP tool does it -- see
 * that function's doc comment for why a conversation id, and not a claimed
 * person id, is the thing trusted here.
 *
 * That identity choice matters more on this route than on any MCP tool
 * today: every MCP tool only reads, so a spoofed identity could only leak
 * data back to the wrong asker. This route writes a TechRequest, so a
 * requester id taken from the body would let a forged request file a ticket
 * that shows up as somebody else's -- which is why RequestSchema above has
 * no such field, not even one this route ignores.
 */
export async function POST(request: Request): Promise<Response> {
  // Feature off looks like the route does not exist, same posture as the MCP
  // endpoint and the messenger-token route: never advertise a half-configured
  // integration.
  if (!isMcpConfigured()) {
    return Response.json({ error: "Not Found" }, { status: 404 });
  }

  const expected = mcpBearerToken();
  if (!expected || !constantTimeBearerMatch(request.headers.get("authorization"), expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawBody: unknown = await request.json().catch(() => null);
  const parsed = RequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { conversationId, category, subject, description } = parsed.data;

  const identity = await resolveIdentityFromConversation(conversationId);
  if (!identity.ok) {
    // Audited with a null actor -- we genuinely do not know who this was --
    // and the caller gets the same undifferentiated UNIDENTIFIED_MESSAGE
    // every refusal returns, exactly as the MCP tools do. Distinguishing the
    // reason to the CALLER is a probe for enumerating real conversations;
    // the audit row is the one place that distinction is allowed to survive.
    await recordAudit({
      actorPersonId: null,
      action: "intercom_ticket_sync.unverified",
      entityType: "TechRequest",
      after: { reason: identity.reason },
    });
    return Response.json({ error: UNIDENTIFIED_MESSAGE }, { status: 401 });
  }

  try {
    const { ticket, created } = await createTechRequestFromConversation(identity.personId, {
      intercomConversationId: conversationId,
      category,
      subject,
      description,
    });

    // Step 4 of the design (writing the new number back onto Intercom's
    // "Hub ticket number" attribute) is deliberately not implemented here.
    // That attribute was created on the six Intercom Ticket Types, a
    // different object model from Conversations with its own write endpoint
    // (PUT /tickets/{ticket_id}, ticket_attributes) and its own attribute
    // namespace (PUT /conversations/{id} custom_attributes cannot reach a
    // ticket-type attribute of the same display name). This route only ever
    // has a conversation id, never a ticket id, and there is no documented
    // way to look up or guarantee a linked Ticket from a conversation id
    // alone. Guessing at that mapping risks writing to the wrong object (or
    // silently no-oping) in production, so per the design's own open
    // question this is left out rather than shipped unverified -- see the
    // sync-inbound-report for the full investigation. The ticket still gets
    // created and its number still gets returned to Fin either way, which is
    // the part the design calls the value that must never be sacrificed to
    // this step's best-effort attribute write.

    // Tell IT a ticket arrived. Without this a chat-originated ticket reaches
    // nobody: notifyTicketSubmitted was only ever called from the Hub form, so
    // a ticket opened through Fin would sit in /support/all until somebody
    // happened to look, which for a support queue is indistinguishable from
    // losing it. The requester half is correctly suppressed inside that
    // function for a linked ticket (they are in the conversation and will hear
    // there); the manager alert is a different audience and still fires.
    //
    // Only on first creation. Intercom retries this endpoint, and idempotency
    // that still re-alerted every manager on each retry would trade duplicate
    // tickets for duplicate pages.
    if (created) {
      const requester = await getActivePerson(identity.personId);
      // Already resolved once by resolveIdentityFromConversation, so a miss
      // here means the person was deactivated in between. The ticket is
      // already written; failing the response over a notification would lose
      // the member's request for a cosmetic reason.
      if (requester) {
        await notifyTicketSubmitted(prisma, ticket, requester);
      }
    }

    return Response.json({ number: ticket.number, created });
  } catch (err) {
    if (isDbUnreachableError(err)) {
      log.warn("[support] database unreachable creating ticket from conversation", errorAttrs(err));
      return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
    if (err instanceof SupportStateError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
