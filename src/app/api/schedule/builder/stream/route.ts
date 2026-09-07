/**
 * GET /api/schedule/builder/stream?term=<termId>&dept=<departmentId>
 *
 * Server-sent events carrying one department's schedule board, so two directors
 * building the same term see each other's changes without either of them
 * reloading. The browser holds one EventSource per open Builder; the server
 * pushes, the client never polls.
 *
 * WHAT PUSHES. Change detection is a cheap indexed aggregate (boardRevision:
 * row count + max updatedAt) taken every TICK_MS; the full board is loaded and
 * sent only when that stamp moves. So an idle board costs one tiny query every
 * two seconds and sends nothing, and a change reaches every other viewer within
 * a tick.
 *
 * This is deliberately NOT Postgres LISTEN/NOTIFY. NOTIFY does not survive
 * Neon's pooled connection, so a truly event-driven version would need a direct
 * connection pinned open per viewer (plus the `pg` driver, which this app does
 * not otherwise carry) -- real connection pressure for a handful of concurrent
 * directors. The seam is one function call: swap boardRevision for a NOTIFY
 * subscription and the stream around it is unchanged.
 *
 * LIFETIME. A Vercel function cannot run forever, so the stream closes itself
 * just under maxDuration and EventSource reconnects on its own. Each event
 * carries `id: <revision>`, which the browser replays as Last-Event-ID on
 * reconnect, so a reconnect that finds nothing changed sends no payload.
 *
 * Every event is a full board snapshot rather than a delta. The board is small
 * (one department, one term) and a snapshot cannot desynchronize the way an
 * applied sequence of deltas can when one is missed across a reconnect.
 */

import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { isDbUnreachableError } from "@/platform/db";
import { log, errorAttrs } from "@/platform/logging";
import {
  assertBoardReadable,
  assignmentsFor,
  boardRevision,
  BuilderForbiddenError,
} from "@/modules/schedule/services/builder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Load-bearing: without it the platform default cuts the stream far earlier and
 * the client reconnects every few seconds. 300s is the plan maximum; the loop
 * below stops short of it so the goodbye event is flushed before the function is
 * torn down mid-write.
 */
export const maxDuration = 300;

/** How often the board is checked for changes. */
const TICK_MS = 2_000;
/** Comment frames keep intermediaries from closing an idle connection. */
const HEARTBEAT_MS = 15_000;
/** Stop this far short of maxDuration so the close is ours, not a timeout. */
const LIFETIME_MS = 280_000;

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
  } catch (err) {
    if (err instanceof BuilderForbiddenError) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    if (isDbUnreachableError(err)) {
      // 503 rather than a thrown exception: the client leaves its board alone
      // and EventSource retries, same posture as the notification bell's poll.
      log.warn("[schedule/builder] database unreachable opening the change stream", errorAttrs(err));
      return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
    throw err;
  }

  // A reconnecting browser replays the last id it saw; a first connection can
  // pass the revision the page was rendered with. Either way, an unchanged board
  // sends nothing on connect.
  const lastSeen =
    request.headers.get("last-event-id") ?? url.searchParams.get("rev") ?? null;

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let known = lastSeen;

      function send(chunk: string) {
        if (closed) return;
        controller.enqueue(encoder.encode(chunk));
      }

      function close() {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the client disconnecting; nothing to do.
        }
      }

      // Tell the browser how long to wait before reconnecting, and open with a
      // comment so the connection is established (and `onopen` fires) even when
      // the board has not changed since the client last saw it.
      send(`retry: 3000\n\n`);
      send(`: connected\n\n`);

      const abort = () => close();
      request.signal.addEventListener("abort", abort);

      let lastHeartbeat = Date.now();

      try {
        while (!closed && !request.signal.aborted) {
          if (Date.now() - startedAt > LIFETIME_MS) {
            // Ours, not a timeout: the client treats this as a normal reconnect
            // rather than an error, so no "offline" flash on a healthy stream.
            send(`event: bye\ndata: {"reason":"lifetime"}\n\n`);
            break;
          }

          try {
            const revision = await boardRevision(termId, departmentId);
            if (revision !== known) {
              const assignments = await assignmentsFor(termId, departmentId);
              known = revision;
              send(
                `id: ${revision}\nevent: board\ndata: ${JSON.stringify({ revision, assignments })}\n\n`,
              );
              lastHeartbeat = Date.now();
            } else if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
              send(`: ping\n\n`);
              lastHeartbeat = Date.now();
            }
          } catch (err) {
            if (!isDbUnreachableError(err)) throw err;
            // Ride out a Neon blip: the board on screen is still the last known
            // good one, and the next tick picks up wherever the database landed.
            log.warn("[schedule/builder] database unreachable on a stream tick", errorAttrs(err));
          }

          await new Promise((resolve) => setTimeout(resolve, TICK_MS));
        }
      } catch (err) {
        log.error("[schedule/builder] change stream failed", errorAttrs(err));
      } finally {
        request.signal.removeEventListener("abort", abort);
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disables proxy buffering, without which nothing is delivered until the
      // stream ends -- which for a stream that runs for minutes means nothing.
      "X-Accel-Buffering": "no",
    },
  });
}
