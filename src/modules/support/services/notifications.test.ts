/**
 * TDD tests for support module notification helpers.
 *
 * notifyTicketSubmitted(db, req, requester):
 *   - Confirms to the requester and alerts every support.manage_requests holder.
 *   - Does not double-notify when the requester also holds the manage permission.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createTechRequest } from "./tech-request";
import { notifyTicketSubmitted } from "./notifications";

// ---------------------------------------------------------------------------
// Helpers (copied from tech-request.test.ts / epic.test.ts)
// ---------------------------------------------------------------------------

async function createPerson(
  name: string,
  opts: { netId?: string; contactEmail?: string; epicId?: string; status?: "ACTIVE" | "OFFBOARDED" } = {}
) {
  return prisma.person.create({
    data: {
      name,
      netId: opts.netId ?? null,
      contactEmail: opts.contactEmail ?? null,
      epicId: opts.epicId ?? null,
      status: opts.status ?? "ACTIVE",
    },
  });
}

async function grantPermission(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: {
      name: `Role-${permission}-${Date.now()}-${Math.random()}`,
      isSystem: false,
      grants: { create: [{ permission }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

beforeEach(resetDb);

describe("notifyTicketSubmitted", () => {
  it("confirms to the requester and alerts every manager", async () => {
    const requester = await createPerson("Rea Quester", { contactEmail: "req@example.com" });
    const mgr = await createPerson("Marla Manager", { contactEmail: "mgr@example.com" });
    await grantPermission(mgr.id, "support.manage_requests");

    const req = await createTechRequest(requester.id, {
      category: "GENERAL_IT",
      subject: "S",
      description: "d",
    });

    await notifyTicketSubmitted(prisma, req, requester);

    // The requester gets the receipt template; managers get the distinct alert template.
    const requesterLogs = await prisma.emailLog.findMany({ where: { template: "support.ticket_submitted" } });
    expect(requesterLogs.map((l) => l.toEmail)).toEqual(["req@example.com"]);
    const managerLogs = await prisma.emailLog.findMany({ where: { template: "support.ticket_manager_alert" } });
    expect(managerLogs.map((l) => l.toEmail)).toEqual(["mgr@example.com"]);
  });

  it("does not double-notify when the requester also holds the manage permission", async () => {
    const requester = await createPerson("Marla Manager", { contactEmail: "mgr@example.com" });
    await grantPermission(requester.id, "support.manage_requests");

    const req = await createTechRequest(requester.id, {
      category: "OTHER",
      subject: "S",
      description: "d",
    });

    await notifyTicketSubmitted(prisma, req, requester);

    // Only the requester receipt goes out; the manager alert is skipped for the
    // self-filer, so no manager-alert email is queued.
    const requesterLogs = await prisma.emailLog.findMany({ where: { template: "support.ticket_submitted" } });
    expect(requesterLogs).toHaveLength(1);
    expect(requesterLogs[0].toEmail).toBe("mgr@example.com");
    const managerLogs = await prisma.emailLog.findMany({ where: { template: "support.ticket_manager_alert" } });
    expect(managerLogs).toHaveLength(0);
  });
});
