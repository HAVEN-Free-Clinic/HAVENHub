/**
 * Epic promotion: links an Epic-category TechRequest into the existing Epic
 * pipeline (src/modules/support/services/epic.ts) by spawning a linked
 * EpicRequest from the ticket's captured intake fields.
 *
 * Permission model:
 *   ENFORCED internally (call-site cannot bypass):
 *     promoteToEpic - support.manage_requests
 */

import type { EpicRequest } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";
import { createEpicRequest } from "./epic";
import { MANAGE, SupportForbiddenError, SupportNotFoundError, SupportStateError } from "./tech-request";
import { TERMINAL_STATUSES } from "./manage";

/**
 * Promotes an Epic-category TechRequest into a linked EpicRequest.
 *
 * Requires support.manage_requests (SupportForbiddenError otherwise). The
 * ticket must exist (SupportNotFoundError), must not already be in a
 * terminal state (SupportStateError otherwise -- a resolved/closed/cancelled
 * ticket cannot be silently reopened by promotion), be category EPIC with a
 * subtype set (SupportStateError otherwise), and must not already be linked
 * to an EpicRequest (SupportStateError otherwise).
 *
 * Delegates creation to createEpicRequest, which enforces person-ACTIVE,
 * no-open-request, and kind-vs-epicId rules and audits "epic.request" --
 * those typed errors (EpicStateError / EpicNotFoundError / EpicForbiddenError)
 * propagate unchanged.
 *
 * On success, links the ticket (epicRequestId) and moves it to IN_PROGRESS,
 * then audits "support.epic_promote".
 */
export async function promoteToEpic(actorPersonId: string, techRequestId: string): Promise<EpicRequest> {
  if (!(await can(actorPersonId, MANAGE))) {
    throw new SupportForbiddenError(`${MANAGE} is required.`);
  }

  const t = await prisma.techRequest.findUnique({ where: { id: techRequestId } });
  if (!t) throw new SupportNotFoundError();

  if (TERMINAL_STATUSES.includes(t.status)) {
    throw new SupportStateError(`Cannot create an Epic request for a ${t.status} ticket.`);
  }
  if (t.category !== "EPIC" || !t.epicSubtype) {
    throw new SupportStateError("Only an Epic-category ticket can be promoted.");
  }
  if (t.epicRequestId) {
    throw new SupportStateError("This ticket is already linked to an Epic request.");
  }

  const epic = await createEpicRequest(actorPersonId, {
    personId: t.requesterId,
    kind: t.epicSubtype,
    jobTitle: t.epicJobTitle,
    mirrorEpicId: t.epicMirrorId,
    notes: `Promoted from IT Support #${t.number}: ${t.subject}`,
  });

  await prisma.techRequest.update({
    where: { id: techRequestId },
    data: { epicRequestId: epic.id, status: "IN_PROGRESS" },
  });

  await recordAudit({
    actorPersonId,
    action: "support.epic_promote",
    entityType: "TechRequest",
    entityId: techRequestId,
    after: { epicRequestId: epic.id },
  });

  return epic;
}
