/**
 * GET /api/check-in/stream?event=<eventId>
 *
 * Server-sent events carrying one event's attendance, so two staffers working
 * one door on two laptops see each other's check-ins without either of them
 * reloading. The browser holds one EventSource per open door; the server pushes,
 * the client never polls.
 *
 * Correctness never depended on this -- the unique constraints on EventAttendance
 * mean a double check-in is reported as one, not written as two. What was wrong
 * without it was the SCREEN: each laptop counted only its own taps, so the
 * "38 of 61" line every operator watches drifted further from the truth the
 * busier the door got, and a person already done on the other machine still
 * showed a live Check in button.
 *
 * Modelled directly on /api/schedule/builder/stream, down to the lifetime and
 * heartbeat handling; see that route for why change detection is a polled
 * revision stamp rather than Postgres LISTEN/NOTIFY (NOTIFY does not survive
 * Neon's pooled connections). The seam is one function call: swap
 * attendanceRevision for a NOTIFY subscription and the stream around it is
 * unchanged.
 */

import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { isDbUnreachableError } from "@/platform/db";
import { log, errorAttrs } from "@/platform/logging";
import {
  attendanceRevision,
  doorSnapshot,
  resolveAttendanceAuthority,
} from "@/modules/recruitment/services/attendance-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Load-bearing: without it the platform default cuts the stream far earlier and
 * the client reconnects every few seconds. 300s is the plan maximum; the loop
 * below stops short of it so the goodbye event is flushed before the function is
 * torn down mid-write.
 */
export const maxDuration = 300;

/** How often the event is checked for new attendance. */
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
  const eventId = url.searchParams.get("event");
  if (!eventId) return Response.json({ error: "Bad Request" }, { status: 400 });

  try {
    const actor = await getActivePerson(session.personId);
    if (!actor) return Response.json({ error: "Unauthorized" }, { status: 401 });
    // The same gate the door page itself applies. Deliberately the broad one:
    // this stream reveals who attended, which every viewer of that page already
    // sees, and not the candidate list, whose narrower department scoping is
    // enforced where it is built.
    const authority = await resolveAttendanceAuthority(actor.id);
    if (!authority.all && authority.departmentCodes.length === 0) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
  } catch (err) {
    if (isDbUnreachableError(err)) {
      // 503 rather than a thrown exception: the client leaves its screen alone
      // and EventSource retries, same posture as the builder stream.
      log.warn("[check-in] database unreachable opening the change stream", errorAttrs(err));
      return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
    throw err;
  }

  // A reconnecting browser replays the last id it saw; a first connection can
  // pass the revision it was rendered with. Either way, an unchanged door sends
  // nothing on connect.
  const lastSeen = request.headers.get("last-event-id") ?? url.searchParams.get("rev") ?? null;

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
      // nothing has changed since the client last saw it.
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
            const revision = await attendanceRevision(eventId);
            if (revision !== known) {
              const snapshot = await doorSnapshot(eventId);
              known = snapshot.revision;
              send(
                `id: ${snapshot.revision}\nevent: door\ndata: ${JSON.stringify(snapshot)}\n\n`,
              );
              lastHeartbeat = Date.now();
            } else if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
              send(`: ping\n\n`);
              lastHeartbeat = Date.now();
            }
          } catch (err) {
            if (!isDbUnreachableError(err)) throw err;
            // Ride out a Neon blip: the names on screen are still the last known
            // good ones, and the next tick picks up wherever the database landed.
            log.warn("[check-in] database unreachable on a stream tick", errorAttrs(err));
          }

          await new Promise((resolve) => setTimeout(resolve, TICK_MS));
        }
      } catch (err) {
        log.error("[check-in] change stream failed", errorAttrs(err));
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
