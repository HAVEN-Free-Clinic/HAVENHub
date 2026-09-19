/**
 * POST /api/schedule/auto-assign
 *
 * Two kinds on one endpoint: `preview` works out what a generated schedule would
 * look like and writes nothing, `apply` places a proposal the director approved.
 *
 * A route handler rather than a server action, for the same reason the builder's
 * own writes are one (see ../builder/route.ts): the Builder page is expensive to
 * re-render, and a server action re-renders the whole route on every call. The
 * preview is also a read the director may run several times before applying, and
 * each run must not repaint the board underneath them.
 *
 * Authorization is two layers, matching the builder endpoint: this file checks
 * the caller is signed in, still active, and manages SOME schedule department;
 * the service checks the specific department. A crafted departmentId gets its 403
 * from the service, which is the real boundary.
 */

import { z } from "zod";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { isDbUnreachableError } from "@/platform/db";
import { log, errorAttrs } from "@/platform/logging";
import {
  BuilderForbiddenError,
  BuilderValidationError,
  canManageAnyScheduleDept,
} from "@/modules/schedule/services/builder";
import { previewAutoAssign, applyAutoAssign } from "@/modules/schedule/services/auto-assign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_KEY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

const Body = z.intersection(
  z.object({ termId: z.string().min(1), departmentId: z.string().min(1) }),
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("preview") }),
    z.object({
      kind: z.literal("apply"),
      // Bounded: one term's worth of Saturdays times a cap is comfortably under
      // this, and an unbounded array would be an easy way to make the server
      // sit in a write loop.
      additions: z
        .array(z.object({ dateKey: DATE_KEY, memberId: z.string().min(1) }))
        .max(2000),
    }),
  ]),
);

export async function POST(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.personId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const actor = await getActivePerson(session.personId);
    if (!actor || !(await canManageAnyScheduleDept(actor.id))) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return Response.json({ error: "Bad Request" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: "Bad Request" }, { status: 400 });
    }
    const body = parsed.data;

    try {
      if (body.kind === "preview") {
        const preview = await previewAutoAssign(actor.id, {
          termId: body.termId,
          departmentId: body.departmentId,
        });
        return Response.json(preview);
      }
      const result = await applyAutoAssign(actor.id, {
        termId: body.termId,
        departmentId: body.departmentId,
        additions: body.additions,
      });
      return Response.json(result);
    } catch (err) {
      // Domain errors are answers, not faults: the client shows the message.
      if (err instanceof BuilderForbiddenError) {
        return Response.json({ error: err.message }, { status: 403 });
      }
      if (err instanceof BuilderValidationError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  } catch (err) {
    if (isDbUnreachableError(err)) {
      log.warn("[schedule/auto-assign] database unreachable", errorAttrs(err));
      return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
    throw err;
  }
}
