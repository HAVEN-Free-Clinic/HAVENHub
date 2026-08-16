/**
 * Recover an Intercom Ticket that the Hub has no TechRequest for.
 *
 * Dry-run by default; pass --apply to write.
 *
 *   npm run intercom:recover:dry -- 215475503912170
 *   npm run intercom:recover:apply -- 215475503912170
 *
 * WHY THIS EXISTS
 *
 * Direction 1 opens the Hub record from a single event: ticket.created. It
 * fires once, and Intercom will not fire it again. So any ticket whose
 * ticket.created was refused -- or that existed before the webhook did -- is
 * stranded permanently: it is worked in Intercom, invisible in the Hub, and
 * every later ticket.state.updated for it answers 404 forever because there is
 * no row carrying its id.
 *
 * That is not hypothetical. Intercom ticket 215475503912170 ("Epic Access",
 * filed 2026-08-16 by email) was refused because the sender arrived as an
 * Intercom-generated LEAD whose external_id is a UUID rather than a Person id
 * -- see ConversationIdentityOptions in src/platform/intercom/identity.ts for
 * that whole story. The identity fix stops it happening again; it cannot go
 * back and replay an event Intercom has moved on from. This script is the
 * going-back half.
 *
 * WHAT IT REUSES, AND WHY THAT MATTERS
 *
 * Every step below is the same function the ticket.created webhook calls, in
 * the same order: identity comes from resolveIdentityFromConversation (with the
 * same fallback the webhook opts into), the row comes from
 * createTechRequestFromConversation, the write-back from pushTicketNumber, and
 * the status from applyIntercomTicketStateChange. Nothing here re-derives a
 * requester, a category, or a status on its own. A recovery tool that
 * hand-assembled its own row would be a second, unreviewed definition of what a
 * ticket-from-Intercom means, and the first thing to drift.
 *
 * It is idempotent for the same reason the webhook is: the create collides on
 * the ticket id and returns the existing row, and the status apply is a no-op
 * when the status already matches. Running it twice does nothing the second
 * time.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It never calls notifyTicketSubmitted. The webhook alerts IT because a
 * brand-new chat-originated ticket otherwise reaches nobody. A ticket this
 * script recovers is by definition one IT has already been working in Intercom
 * -- 215475503912170 was assigned and sitting in "Waiting on YNHH ITS" -- so
 * paging every manager about it would be noise about work already in hand.
 */

import { prisma } from "@/platform/db";
import { intercomAccessToken } from "@/platform/intercom/config";
import { resolveIdentityFromConversation } from "@/platform/intercom/identity";
import { extractTicketStateInternalLabel, fetchTicket, pushTicketNumber } from "@/platform/intercom/tickets";
import {
  applyIntercomTicketStateChange,
  mapIntercomTicketStateToStatus,
  mapIntercomTicketTypeToCategory,
} from "@/modules/support/services/intercom-sync";
import { createTechRequestFromConversation } from "@/modules/support/services/tech-request";

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * Reads the same three fields, from the same places, as handleTicketCreated.
 * A ticket fetched from the REST API and a ticket delivered on a webhook are
 * the same object, so this stays deliberately identical to that handler rather
 * than "improving" on it.
 */
function readTicket(ticket: unknown) {
  const item = (ticket && typeof ticket === "object" ? ticket : {}) as Record<string, unknown>;
  const attrs = (item.ticket_attributes && typeof item.ticket_attributes === "object"
    ? (item.ticket_attributes as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const ticketType = item.ticket_type;
  const ticketTypeName =
    ticketType && typeof ticketType === "object" && "name" in ticketType
      ? asString((ticketType as Record<string, unknown>).name)
      : null;

  return {
    id: asString(item.id),
    subject: asString(attrs["_default_title_"]) ?? "",
    description: asString(attrs["_default_description_"]) ?? "",
    ticketTypeName,
    internalLabel: extractTicketStateInternalLabel(item),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const ticketId = args.find((a) => !a.startsWith("--"));

  if (!ticketId) {
    console.error("Usage: npm run intercom:recover:dry -- <intercomTicketId>");
    process.exit(1);
  }
  if (!intercomAccessToken()) {
    console.error("INTERCOM_ACCESS_TOKEN is not set. Pass --env-file for the file that carries it.");
    process.exit(1);
  }

  console.log(apply ? `APPLY: recovering ${ticketId}` : `DRY RUN (pass --apply to write): ${ticketId}`);

  const ticket = readTicket(await fetchTicket(ticketId));
  if (!ticket.id) {
    console.error(`Intercom returned no ticket for ${ticketId}. Nothing to recover.`);
    process.exit(1);
  }
  console.log(`  Intercom ticket: type=${ticket.ticketTypeName ?? "(none)"} state=${ticket.internalLabel ?? "(none)"}`);
  console.log(`  Subject: ${ticket.subject || "(blank)"}`);

  // The ticket id is also the conversation id for a ticket converted in place,
  // which is why both columns are checked -- see handleTicketCreated.
  const existing = await prisma.techRequest.findFirst({
    where: { OR: [{ intercomTicketId: ticketId }, { intercomConversationId: ticketId }] },
    select: { id: true, number: true, status: true, intercomTicketId: true },
  });

  if (existing?.intercomTicketId === ticketId) {
    console.log(`  Already linked to Hub ticket #${existing.number} (${existing.status}).`);
  } else if (existing) {
    // The other way a ticket goes unlinked: the row was opened from the
    // conversation (Fin's custom action, which has no ticket id to store) and
    // the conversation was converted to a Ticket afterwards. The row exists,
    // but nothing carries the ticket id, so Direction 3 cannot find it.
    console.log(`  Hub ticket #${existing.number} exists but carries no Intercom ticket id. Linking it.`);
    if (apply) {
      await prisma.techRequest.update({ where: { id: existing.id }, data: { intercomTicketId: ticketId } });
    }
  } else {
    if (!ticket.subject.trim() || !ticket.description.trim()) {
      console.error("  Ticket has no subject or no description; refusing to create a blank Hub ticket.");
      process.exit(1);
    }

    const identity = await resolveIdentityFromConversation(ticketId, { allowVerifiedEmailFallback: true });
    if (!identity.ok) {
      console.error(`  Could not resolve a requester (${identity.reason}). Nothing written.`);
      console.error("  A ticket from someone who is not an active member cannot be attributed to anyone.");
      process.exit(1);
    }
    const category = mapIntercomTicketTypeToCategory(ticket.ticketTypeName);
    console.log(`  Requester resolves to person ${identity.personId} (via ${identity.via}); category ${category}.`);

    if (!apply) {
      console.log("  Would create the Hub ticket, write its number back to Intercom, and sync its status.");
      const wouldBe = ticket.internalLabel ? mapIntercomTicketStateToStatus(ticket.internalLabel) : null;
      console.log(`  Status would land on ${wouldBe ?? "SUBMITTED (state unmapped or absent)"}.`);
      return;
    }

    const { ticket: created } = await createTechRequestFromConversation(identity.personId, {
      intercomConversationId: ticketId,
      intercomTicketId: ticketId,
      category,
      subject: ticket.subject,
      description: ticket.description,
    });
    console.log(`  Created Hub ticket #${created.number}.`);

    // Best-effort, exactly as on the webhook: the row is what matters, the
    // attribute write is cosmetic.
    const pushed = await pushTicketNumber(ticketId, created.number);
    console.log(pushed ? `  Wrote #${created.number} back onto the Intercom ticket.` : "  Number write-back failed (cosmetic).");
  }

  // Finally, bring the Hub status up to whatever Intercom says NOW. The
  // ticket.state.updated events that fired while the row did not exist are
  // gone; this is the one chance to catch up on them, and it is why recovery
  // does not just mean "create the row".
  if (!ticket.internalLabel) {
    console.log("  Intercom reports no state label for this ticket; leaving status alone.");
    return;
  }
  if (!apply) {
    console.log(`  Would then sync status from Intercom state "${ticket.internalLabel}".`);
    return;
  }
  const result = await applyIntercomTicketStateChange(ticketId, ticket.internalLabel);
  if (!result.ok) {
    console.error(`  Status sync refused (${result.reason}). The ticket exists; its status did not move.`);
    return;
  }
  console.log(
    result.changed
      ? `  Status synced to ${result.ticket.status} from Intercom state "${ticket.internalLabel}".`
      : `  Status already matched Intercom (${result.ticket.status}).`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
