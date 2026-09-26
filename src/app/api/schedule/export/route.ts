/**
 * GET /api/schedule/export?term=<termId>&dept=<departmentId>
 *
 * Downloads one department's schedule for one term as an .xlsx: date, name,
 * role, tags, RN, Spanish score, and whether they are a first-timer. First-time
 * applicants' draft shifts are included, as they are on the builder's board.
 *
 * A GET so the builder can offer it as a plain download link. It changes
 * nothing, and the Spanish score it carries is internal, so the read is gated
 * on the same authority as the builder itself: the viewer must manage this
 * department's schedule (assertBoardReadable). Every download is audited.
 */

import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { prisma, isDbUnreachableError } from "@/platform/db";
import { log, errorAttrs } from "@/platform/logging";
import { recordAudit } from "@/platform/audit";
import { contentDisposition } from "@/platform/content-disposition";
import { assertBoardReadable, BuilderForbiddenError } from "@/modules/schedule/services/builder";
import {
  buildScheduleWorkbook,
  loadScheduleExportRows,
  scheduleExportFilename,
} from "@/modules/schedule/services/schedule-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function GET(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.personId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const termId = url.searchParams.get("term");
  const departmentId = url.searchParams.get("dept");
  if (!termId || !departmentId) {
    return Response.json({ error: "Bad Request" }, { status: 400 });
  }

  try {
    const actor = await getActivePerson(session.personId);
    if (!actor) return Response.json({ error: "Unauthorized" }, { status: 401 });
    await assertBoardReadable(actor.id, departmentId);

    const [term, department] = await Promise.all([
      prisma.term.findUnique({ where: { id: termId }, select: { code: true } }),
      prisma.department.findUnique({ where: { id: departmentId }, select: { code: true } }),
    ]);
    if (!term || !department) {
      return Response.json({ error: "Not Found" }, { status: 404 });
    }

    const rows = await loadScheduleExportRows(termId, departmentId);
    const workbook = await buildScheduleWorkbook(rows);

    await recordAudit({
      actorPersonId: actor.id,
      action: "schedule.export",
      entityType: "Department",
      entityId: departmentId,
      after: { termCode: term.code, departmentCode: department.code, rowCount: rows.length },
    });

    const filename = scheduleExportFilename(department.code, term.code);
    return new Response(new Uint8Array(workbook), {
      headers: {
        "Content-Type": XLSX_TYPE,
        "Content-Disposition": contentDisposition(filename, { fallbackName: "schedule.xlsx" }),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof BuilderForbiddenError) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    if (isDbUnreachableError(err)) {
      log.warn("[schedule/export] database unreachable building the export", errorAttrs(err));
      return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
    throw err;
  }
}
