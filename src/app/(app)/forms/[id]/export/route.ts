import { NextResponse } from "next/server";
import { requirePermission } from "@/platform/auth/session";
import { getForm, listResponses, responsesCsv } from "@/modules/forms/service";
import { recordAudit } from "@/platform/audit";

/** The form's responses as CSV, for spreadsheets. Staff only. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("forms.manage");
  const { id } = await params;
  const form = await getForm(id);
  if (!form) return new NextResponse("Not found", { status: 404 });
  const csv = responsesCsv(form.parsedLayout, await listResponses(id));
  await recordAudit({ actorPersonId: actor.personId, action: "form.export", entityType: "Form", entityId: id });
  const filename = `${form.title.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-") || "form"}-responses.csv`;
  return new NextResponse(`﻿${csv}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
