/**
 * Shift request pending reminders.
 * Finds PENDING shift requests older than 48 hours and re-notifies
 * the department directors so requests don't get forgotten.
 *
 * Triggered DAILY by an external scheduler (cron-job.org) hitting this path
 * with Authorization: Bearer $CRON_SECRET. Add to cron-job.org alongside the
 * existing compliance reminders job.
 *
 * Only enqueues emails - delivery is handled by the per-minute
 * /api/cron/email route.
 */
import { authorizeCron } from "@/platform/cron";
import { prisma } from "@/platform/db";
import { queueEmail } from "@/platform/email/send";
import { renderTemplate } from "@/platform/email/render/render";
import { getDescriptor } from "@/platform/email/templates/registry";
import { businessDaysSince } from "@/platform/dates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);

  const pendingRequests = await prisma.shiftRequest.findMany({
    where: {
      status: "PENDING",
      createdAt: { lt: cutoff },
    },
    include: {
      requester: { select: { name: true } },
      target: { select: { name: true } },
      department: { select: { id: true, name: true } },
      term: { select: { id: true } },
    },
  });

  const descriptor = getDescriptor("schedule-request-submitted-director");
  if (!descriptor) return Response.json({ ok: true, reminded: 0 });

  let reminded = 0;

  for (const req of pendingRequests) {
    const isSwap = !!(req.targetId && req.targetDate);
    const requesterDateStr = req.requesterDate.toLocaleDateString("en-US", {
      month: "long", day: "numeric", year: "numeric",
    });
    const partnerDateStr = req.targetDate
      ? req.targetDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
      : "";

    // Find all directors assigned in this department for the active term.
    const directorAssignments = await prisma.shiftAssignment.findMany({
      where: {
        termId: req.termId,
        departmentId: req.departmentId,
        role: "DIRECTOR",
      },
      select: {
        person: { select: { id: true, name: true, contactEmail: true } },
      },
    });

    const uniqueDirectors = new Map<string, { id: string; name: string; contactEmail: string | null }>(
        directorAssignments.map((a: { person: { id: string; name: string; contactEmail: string | null } }) => [a.person.id, a.person])
      );

      for (const director of uniqueDirectors.values()) {
      if (!director.contactEmail) continue;
      try {
        const daysPending = businessDaysSince(req.createdAt);
        const subject = renderTemplate(
          `Reminder: shift request pending ${daysPending} business day${daysPending !== 1 ? "s" : ""} - HAVEN`,
          {},
        );
        const html = renderTemplate(descriptor.defaultBody, {
          directorName: director.name?.split(" ")[0] ?? director.name ?? "",
          requesterName: req.requester.name,
          requestType: isSwap ? "swap" : "drop",
          requesterDate: requesterDateStr,
          partnerName: req.target?.name ?? "",
          partnerDate: partnerDateStr,
          departmentName: req.department.name,
        });
        await queueEmail(prisma, {
          to: director.contactEmail,
          subject,
          html,
          template: "schedule-request-submitted-director",
          personId: director.id,
          triggeredById: director.id,
        });
        reminded++;
      } catch {
        // Best-effort.
      }
    }
  }

  return Response.json({ ok: true, reminded });
}
