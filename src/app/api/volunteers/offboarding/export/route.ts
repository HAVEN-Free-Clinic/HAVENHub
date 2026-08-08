/**
 * POST /api/volunteers/offboarding/export
 *
 * Serves the removal-list CSV for the Transition tab (a selection) or the
 * Flagged tab (everyone offboarded this term). Member email addresses leave the
 * system here, so every call is audited.
 *
 * Auth: signed-in holder of volunteers.manage_offboarding. Returns 401 for both
 * unauthenticated and unauthorized, matching the other API routes in this
 * codebase; requirePermission is page-only because it redirects.
 */

import { NextResponse } from "next/server";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { contentDisposition } from "@/platform/content-disposition";
import {
  buildOffboardingCsv,
  type ExportRequest,
} from "@/modules/volunteers/services/offboarding-export";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.personId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const actor = await getActivePerson(session.personId);
  if (!actor || !(await can(actor.id, "volunteers.manage_offboarding"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as { scope?: string; personIds?: string[] };

  let input: ExportRequest;
  if (body.scope === "offboarded-term") {
    input = { scope: "offboarded-term" };
  } else if (body.scope === "selection") {
    if (!body.personIds?.length) {
      return NextResponse.json({ error: "No people selected" }, { status: 400 });
    }
    input = { scope: "selection", personIds: body.personIds };
  } else {
    return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
  }

  const { filename, csv, rowCount } = await buildOffboardingCsv(input, new Date());

  await recordAudit({
    actorPersonId: actor.id,
    action: "offboarding.export",
    entityType: "Person",
    after: { scope: input.scope, rowCount },
  });

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": contentDisposition(filename, { fallbackName: "offboarding.csv" }),
    },
  });
}
