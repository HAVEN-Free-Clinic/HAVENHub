/**
 * POST /api/schedule/builder
 *
 * The write half of the interactive Schedule Builder: assign, unassign, and tag
 * toggles, one small JSON call per click.
 *
 * Why a route handler and not a Server Action. Next re-renders the current
 * route's Server Components after EVERY server action and streams the whole RSC
 * payload back -- for this page that is builderView (availability resolution,
 * clearance, conflicts, intake, the incoming class), the request list, the
 * profile-visibility pass and the term switcher, on every cell click. The old
 * builder additionally redirected to its own URL on success, which threw away
 * the page's scroll position and the grid's horizontal scroll along with it.
 * This endpoint does neither: it writes one row and hands back the board.
 *
 * Authorization is the same authority the page requires, in two layers:
 *   1. here -- signed in, still ACTIVE, and manages at least one schedule
 *      department (mirrors the page's canManageAnyScheduleDept gate);
 *   2. inside setAssignment / toggleTag -- scopeCheck against the specific
 *      department, which is the real boundary. A crafted departmentId gets a
 *      403 from the service, not from this file.
 *
 * The response carries the whole board for the (term, department) rather than
 * just the touched cell: it is one indexed query, it costs a fraction of the
 * page render this replaces, and it means the client reconciles against server
 * truth after every write instead of accumulating drift from its own optimistic
 * guesses.
 */

import { z } from "zod";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { isDbUnreachableError } from "@/platform/db";
import { log, errorAttrs } from "@/platform/logging";
import {
  assertBoardReadable,
  assignmentsFor,
  boardRevision,
  canManageAnyScheduleDept,
  setAssignment,
  toggleTag,
  BuilderForbiddenError,
  BuilderValidationError,
  SHIFT_ROLES,
  SHIFT_TAGS,
} from "@/modules/schedule/services/builder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_KEY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

const Body = z.intersection(
  z.object({
    termId: z.string().min(1),
    departmentId: z.string().min(1),
    dateKey: DATE_KEY,
    personId: z.string().min(1),
  }),
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("assign"), role: z.enum(SHIFT_ROLES) }),
    // Free text, captured into the audit trail by setAssignment. Bounded here so
    // an unbounded string cannot be pushed through into an audit row.
    z.object({ kind: z.literal("unassign"), reason: z.string().max(500).optional() }),
    z.object({ kind: z.literal("tag"), tag: z.enum(SHIFT_TAGS) }),
  ]),
);

/**
 * GET /api/schedule/builder?term=<termId>&dept=<departmentId>
 *
 * The board as the server has it. The client reads this when a write is
 * rejected and it has no newer snapshot to fall back on: the optimistic change
 * has to come back out, and only the server knows what is actually there.
 * Ordinary updates arrive over the change stream, not from here.
 */
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

    const [assignments, revision] = await Promise.all([
      assignmentsFor(termId, departmentId),
      boardRevision(termId, departmentId),
    ]);
    return Response.json({ assignments, revision });
  } catch (err) {
    if (err instanceof BuilderForbiddenError) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    if (isDbUnreachableError(err)) {
      log.warn("[schedule/builder] database unreachable reading the board", errorAttrs(err));
      return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
    throw err;
  }
}

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
      if (body.kind === "tag") {
        await toggleTag(actor.id, {
          termId: body.termId,
          departmentId: body.departmentId,
          dateKey: body.dateKey,
          personId: body.personId,
          tag: body.tag,
        });
      } else {
        await setAssignment(actor.id, {
          termId: body.termId,
          departmentId: body.departmentId,
          dateKey: body.dateKey,
          personId: body.personId,
          role: body.kind === "assign" ? body.role : null,
          reason: body.kind === "unassign" ? body.reason : undefined,
        });
      }
    } catch (err) {
      // Domain errors are answers, not faults: the client reverts its optimistic
      // change and shows the message. Everything else falls through and is
      // captured as an exception, which is what a real bug should do.
      if (err instanceof BuilderForbiddenError) {
        return Response.json({ error: err.message }, { status: 403 });
      }
      if (err instanceof BuilderValidationError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    const [assignments, revision] = await Promise.all([
      assignmentsFor(body.termId, body.departmentId),
      boardRevision(body.termId, body.departmentId),
    ]);
    return Response.json({ assignments, revision });
  } catch (err) {
    // A Neon blip must not file an exception per click, hence 503 rather than a
    // 500 and an error report.
    //
    // This used to say the client "keeps its optimistic state on a 503 and the
    // next stream tick reconciles it". Reconciling is precisely what throws the
    // write away: the client rolls back to server truth, so the edit is lost.
    // The client now says so rather than claiming the change was saved and is
    // being retried (see builder-board.tsx's 503 branch).
    if (isDbUnreachableError(err)) {
      log.warn("[schedule/builder] database unreachable writing an assignment", errorAttrs(err));
      return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
    throw err;
  }
}
