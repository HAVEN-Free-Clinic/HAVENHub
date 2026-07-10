/**
 * Support module notification helpers.
 *
 * notifyTicketSubmitted fans out on ticket creation: a confirmation email to
 * the requester, then one alert per current holder of support.manage_requests
 * (skipping the requester so a manager who files their own ticket is not
 * double-notified).
 */

import type { Prisma, PrismaClient, TechRequest, Person } from "@prisma/client";
import { notify } from "@/platform/notifications/notify";
import { peopleWithAnyPermission } from "@/platform/rbac/holders";
import { getSetting } from "@/platform/settings/service";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { MANAGE } from "./tech-request";

type Db = PrismaClient | Prisma.TransactionClient;

function ticketLink(baseUrl: string, id: string): string {
  return `${baseUrl}/support/${id}`;
}

/** Settings are unset in tests; the resolved base URL falls back to "" so links are still well-formed relative paths. */
async function resolveBaseUrl(): Promise<string> {
  return (await getSetting<string>("app.baseUrl")) ?? "";
}

/**
 * Notify on ticket submission: a confirmation to the requester, then a
 * per-person fan-out alert to every current holder of support.manage_requests.
 */
export async function notifyTicketSubmitted(
  db: Db,
  req: TechRequest,
  requester: Pick<Person, "id" | "name" | "entraObjectId" | "contactEmail">
): Promise<void> {
  const link = ticketLink(await resolveBaseUrl(), req.id);

  // Confirmation to the requester.
  const conf = await renderEmail("support.ticket_submitted", {
    ticketNumber: req.number,
    subject: req.subject,
    link,
    isManager: false,
  });
  await notify(db, {
    type: "support.ticket_submitted",
    person: requester,
    email: { subject: conf.subject, html: conf.html },
    teams: { title: `IT Support #${req.number} received`, summary: req.subject, link },
    triggeredById: requester.id,
  });

  // Alert every manager (per-person fan-out), skipping the requester so a
  // manager who files their own ticket does not get a duplicate email. The
  // manager-variant email content is identical for every recipient, so it is
  // rendered once outside the loop.
  const managers = await peopleWithAnyPermission([MANAGE]);
  const mgr = await renderEmail("support.ticket_submitted", {
    ticketNumber: req.number,
    subject: req.subject,
    link,
    isManager: true,
    requesterName: requester.name ?? "A volunteer",
  });
  for (const m of managers) {
    if (m.id === requester.id) continue;
    await notify(db, {
      type: "support.ticket_submitted",
      person: m,
      email: { subject: mgr.subject, html: mgr.html },
      teams: { title: `New IT Support #${req.number}`, summary: req.subject, link },
      triggeredById: requester.id,
    });
  }
}
