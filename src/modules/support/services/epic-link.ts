/**
 * Epic attach: links one or more EpicRequests to an IT Support ticket
 * (src/modules/support/services/epic.ts owns the downstream pipeline). A
 * manager chooses the kind and the target people at attach time; the requester
 * is no longer the implicit subject, and one ticket may hold many requests.
 *
 * Permission model:
 *   ENFORCED internally (call-site cannot bypass):
 *     attachEpicRequests - support.manage_requests
 */
import type { EpicRequest, EpicRequestKind } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";
import { log, errorAttrs } from "@/platform/logging";
import { MANAGE, SupportForbiddenError, SupportNotFoundError, SupportStateError } from "./tech-request";
import { TERMINAL_STATUSES, setStatus } from "./manage";

const ATTACHABLE_KINDS: EpicRequestKind[] = ["NEW", "MODIFY", "RENEW"];

/**
 * Attaches one Epic request per person to a support ticket.
 *
 * Requires support.manage_requests. kind must be NEW/MODIFY/RENEW. personIds
 * must be non-empty. The ticket must exist and be non-terminal. Works for any
 * ticket category and even when the ticket already has attached requests.
 *
 * Validates every person up front (rules copied from createEpicRequest in
 * epic.ts; keep the two in sync) and creates in one transaction, so a single
 * bad person rejects the whole batch (no partial attach). A brand-new
 * (SUBMITTED) ticket is advanced to IN_PROGRESS; a later-stage ticket is left
 * untouched. Audits "support.epic_attach".
 *
 * The IN_PROGRESS advance itself happens AFTER the transaction commits, via
 * manage.ts's setStatus rather than a raw column write inside the transaction:
 * setStatus is what pushes the status change out to Intercom (staff note and/or
 * ticket-state push) and records "support.status_change", and it performs that
 * network I/O -- it must never run inside an open database transaction, where a
 * slow or failing external call would hold the transaction open or force a
 * rollback of already-good work. The advance is therefore best-effort: the
 * Epic requests are already attached and committed by the time it runs, so a
 * failure here (Intercom unreachable, or the ticket changed state concurrently)
 * does not undo the attach and does not throw to the caller -- it is logged and
 * audited as "support.epic_attach_status_advance_failed" instead. See other
 * outbound Intercom paths in this module family (e.g. epic-ticket-sync.ts) for
 * the same shape.
 */
export async function attachEpicRequests(
  actorPersonId: string,
  techRequestId: string,
  input: { kind: EpicRequestKind; personIds: string[] }
): Promise<EpicRequest[]> {
  if (!(await can(actorPersonId, MANAGE))) {
    throw new SupportForbiddenError(`${MANAGE} is required.`);
  }
  if (!ATTACHABLE_KINDS.includes(input.kind)) {
    throw new SupportStateError(
      `Invalid Epic request kind: ${input.kind}. Must be New, Modification, or Renewal.`
    );
  }
  const personIds = [...new Set(input.personIds)].filter(Boolean);
  if (personIds.length === 0) {
    throw new SupportStateError("Select at least one person to attach an Epic request.");
  }

  const t = await prisma.techRequest.findUnique({ where: { id: techRequestId } });
  if (!t) throw new SupportNotFoundError();
  if (TERMINAL_STATUSES.includes(t.status)) {
    throw new SupportStateError(
      `Cannot attach an Epic request to a ${t.status} ticket. Reopen it first.`
    );
  }

  // Set inside the transaction below, read after it commits. setStatus (the
  // only correct way to advance a ticket's status -- see the doc comment
  // above) does network I/O and must not run inside prisma.$transaction, so
  // the transaction only records WHETHER the advance is needed and the actual
  // call happens once everything above has safely landed.
  let advanceToInProgress = false;

  const created = await prisma.$transaction(async (tx) => {
    const people = await tx.person.findMany({
      where: { id: { in: personIds } },
      select: { id: true, name: true, status: true, epicId: true },
    });
    const byId = new Map(people.map((p) => [p.id, p]));
    for (const personId of personIds) {
      const person = byId.get(personId);
      const who = person?.name ?? "This person";
      if (!person) throw new SupportNotFoundError(`Person not found: ${personId}`);
      if (person.status !== "ACTIVE") {
        throw new SupportStateError(`${who} is not an active member; cannot attach an Epic request.`);
      }
      if (input.kind === "NEW" && person.epicId) {
        throw new SupportStateError(`${who} already has an Epic ID; attach a Modify or Renew instead of New.`);
      }
      if ((input.kind === "MODIFY" || input.kind === "RENEW") && !person.epicId) {
        throw new SupportStateError(`${who} has no Epic ID on file; attach a New request instead of ${input.kind}.`);
      }
    }

    const open = await tx.epicRequest.findMany({
      where: { personId: { in: personIds }, status: { in: ["PENDING", "SUBMITTED"] } },
      include: { person: { select: { name: true } } },
    });
    if (open.length > 0) {
      const names = [...new Set(open.map((r) => r.person.name))].join(", ");
      throw new SupportStateError(
        `An open Epic request already exists for: ${names}. Cancel it before attaching another.`
      );
    }

    await tx.epicRequest.createMany({
      data: personIds.map((personId) => ({
        personId,
        kind: input.kind,
        status: "PENDING" as const,
        requestedById: actorPersonId,
        techRequestId,
        notes: `Attached from IT Support #${t.number}: ${t.subject}`,
      })),
    });

    advanceToInProgress = t.status === "SUBMITTED";

    // No open request existed for these people before this call, so every
    // PENDING row for them on this ticket is one we just created.
    return tx.epicRequest.findMany({
      where: { techRequestId, personId: { in: personIds }, status: "PENDING" },
      orderBy: { createdAt: "asc" },
    });
  });

  await recordAudit({
    actorPersonId,
    action: "support.epic_attach",
    entityType: "TechRequest",
    entityId: techRequestId,
    after: { personIds, kind: input.kind, count: created.length },
  });

  if (advanceToInProgress) {
    try {
      await setStatus(actorPersonId, techRequestId, "IN_PROGRESS");
    } catch (err) {
      // Best-effort: the Epic requests above are already attached and
      // committed, so a failure to advance the ticket (or reach Intercom, from
      // inside setStatus) must not throw away that work or fail this call. The
      // failure is recorded rather than silently dropped -- see the doc
      // comment above.
      log.warn(
        "[support] failed to advance ticket status to IN_PROGRESS after Epic attach",
        errorAttrs(err, { techRequestId })
      );
      await recordAudit({
        actorPersonId,
        action: "support.epic_attach_status_advance_failed",
        entityType: "TechRequest",
        entityId: techRequestId,
        after: { targetStatus: "IN_PROGRESS", error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  return created;
}
