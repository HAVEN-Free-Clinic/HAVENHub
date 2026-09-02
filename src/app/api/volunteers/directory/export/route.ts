/**
 * POST /api/volunteers/directory/export
 *
 * Serves the people-directory CSV: the filtered roster, or the attending list.
 * Name, NetID, both email addresses and phone for everyone matching the filter
 * leave the system here, which makes this the widest bulk PII egress in the
 * app -- so every call is audited, including the filter that produced it and
 * the row count that left. Mirrors the offboarding export route.
 *
 * Auth: signed-in holder of EITHER volunteers.view_directory (clinic-wide) or
 * volunteers.view_directory_own_dept (the departments they direct). Which one
 * they hold decides how much of the clinic the file contains, resolved by the
 * same directoryScopeFor the page uses so a download can never be wider than
 * the screen it came from. Returns 401 for both unauthenticated and
 * unauthorized, matching the other API routes in this codebase;
 * requirePermission is page-only because it redirects.
 */

import { NextResponse } from "next/server";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { contentDisposition } from "@/platform/content-disposition";
import { directoryScopeFor } from "@/modules/volunteers/services/directory";
import {
  buildDirectoryCsv,
  type DirectoryExportRequest,
} from "@/modules/volunteers/services/directory-export";

type Body = {
  scope?: string;
  departmentId?: string;
  kind?: string;
  q?: string;
};

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.personId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const actor = await getActivePerson(session.personId);
  if (
    !actor ||
    !(
      (await can(actor.id, "volunteers.view_directory")) ||
      (await can(actor.id, "volunteers.view_directory_own_dept"))
    )
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // What they may see, as opposed to what they asked for. Every selector below
  // takes it, so a scoped director's "everyone" is their departments' everyone.
  const viewerScope = await directoryScopeFor(actor.id);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  let input: DirectoryExportRequest;
  if (body.scope === "attendings") {
    input = { scope: "attendings" };
  } else if (body.scope === "people") {
    // Validated, not passed through: `kind` reaches a Prisma enum filter, and a
    // departmentId that names nothing must select nobody rather than silently
    // dropping the filter and exporting the entire clinic.
    const kind =
      body.kind === "DIRECTOR" || body.kind === "VOLUNTEER" ? body.kind : undefined;
    input = {
      scope: "people",
      ...(body.departmentId ? { departmentId: body.departmentId } : {}),
      ...(kind ? { kind } : {}),
      ...(body.q?.trim() ? { q: body.q.trim() } : {}),
    };
  } else {
    return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
  }

  const activeTerm = await getActiveTerm();
  // Resolved for the filename only. A departmentId that matches no department
  // still reaches the query, where it correctly selects nobody.
  const department =
    input.scope === "people" && input.departmentId
      ? await prisma.department.findUnique({
          where: { id: input.departmentId },
          select: { code: true },
        })
      : null;

  const { filename, csv, rowCount } = await buildDirectoryCsv(
    input,
    viewerScope,
    {
      termId: activeTerm?.id ?? null,
      termCode: activeTerm?.code ?? null,
      departmentCode: department?.code ?? null,
    },
    new Date(),
  );

  await recordAudit({
    actorPersonId: actor.id,
    action: "directory.export",
    entityType: "Person",
    after: {
      scope: input.scope,
      rowCount,
      // The audit for the widest bulk PII egress in the app has to say how wide
      // "wide" was for this caller: null is the whole clinic, a list is the
      // departments their grant reaches.
      viewerDepartmentIds: viewerScope?.departmentIds ?? null,
      ...(input.scope === "people"
        ? {
            departmentCode: department?.code ?? null,
            kind: input.kind ?? null,
            search: input.q ?? null,
          }
        : {}),
    },
  });

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": contentDisposition(filename, { fallbackName: "directory.csv" }),
    },
  });
}
