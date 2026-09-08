/**
 * Integration tests for the door's change stream.
 *
 * Two things matter here and neither is the streaming machinery: that the stream
 * is gated by the same attendance authority the door page is (it carries every
 * attendee's name out of the database), and that it pushes a snapshot exactly
 * when the event has moved past what the client says it has seen.
 *
 * Each test that opens the stream aborts it as soon as it has what it needs; the
 * route otherwise runs for minutes by design.
 *
 * Mirrors api/schedule/builder/stream/route.test.ts, which this route is
 * modelled on.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { attendanceRevision } from "@/modules/recruitment/services/attendance-events";

vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));

import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

async function fixture() {
  const term = await prisma.term.create({
    data: {
      code: "FA26",
      name: "Fall 2026",
      startDate: new Date("2026-08-01T12:00:00.000Z"),
      endDate: new Date("2026-12-15T12:00:00.000Z"),
      status: "ACTIVE",
    },
  });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });

  const door = await prisma.person.create({ data: { name: "Door", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "Door", grants: { create: [{ permission: "recruitment.record_attendance" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: door.id, roleId: role.id } });

  // Signed in, and holding nothing that lets them record attendance anywhere.
  const outsider = await prisma.person.create({ data: { name: "Nobody", status: "ACTIVE" } });

  const event = await prisma.attendanceEvent.create({
    data: {
      termId: term.id,
      kind: "INFO_SESSION",
      title: "Fall info session",
      startsAt: new Date("2026-09-03T22:00:00.000Z"),
    },
  });
  return { term, dept, door, outsider, event };
}

function signedInAs(personId: string) {
  mocked(auth).mockResolvedValue({ personId });
  mocked(getActivePerson).mockResolvedValue({ id: personId });
}

/**
 * Read frames until `want` matches one, then abort. Resolves with everything
 * read; rejects if the stream ends or the deadline passes without a match, so a
 * regression fails rather than hangs.
 */
async function readUntil(
  res: Response,
  controller: AbortController,
  want: (text: string) => boolean,
  timeoutMs = 10_000,
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let text = "";
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (want(text)) return text;
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
  throw new Error(`stream ended or timed out; saw: ${JSON.stringify(text)}`);
}

function open(params: string, controller: AbortController): Request {
  return new Request(`http://localhost/api/check-in/stream${params}`, {
    signal: controller.signal,
  });
}

describe("GET /api/check-in/stream", () => {
  beforeEach(async () => {
    await resetDb();
    vi.resetAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    mocked(auth).mockResolvedValue(null);
    const { GET } = await import("./route");
    const c = new AbortController();
    expect((await GET(open("?event=e", c))).status).toBe(401);
  });

  it("returns 400 without an event", async () => {
    const { door } = await fixture();
    signedInAs(door.id);
    const { GET } = await import("./route");
    const c = new AbortController();
    expect((await GET(open("", c))).status).toBe(400);
  });

  // The stream carries every attendee's name, so it needs the authority the door
  // page does, not merely a signed-in session.
  it("returns 403 for a viewer who may not record attendance anywhere", async () => {
    const { outsider, event } = await fixture();
    signedInAs(outsider.id);
    const { GET } = await import("./route");
    const c = new AbortController();
    expect((await GET(open(`?event=${event.id}`, c))).status).toBe(403);
  });

  it("opens as an event stream for door staff", async () => {
    const { door, event } = await fixture();
    signedInAs(door.id);
    const { GET } = await import("./route");
    const c = new AbortController();
    const res = await GET(open(`?event=${event.id}`, c));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    // Without this, a proxy buffers the whole response and delivers nothing
    // until the stream ends -- which for a stream that runs for minutes means
    // nothing at all.
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");

    const text = await readUntil(res, c, (t) => t.includes(": connected"));
    expect(text).toContain("retry: 3000");
  });

  it("pushes the attendance when the client's revision is behind", async () => {
    const { door, event } = await fixture();
    await prisma.eventAttendance.create({
      data: {
        eventId: event.id,
        attendeeName: "Walk Up",
        attendeeEmail: "walkup@yale.edu",
        method: "WALK_UP",
      },
    });
    signedInAs(door.id);
    const { GET } = await import("./route");
    const c = new AbortController();
    const res = await GET(open(`?event=${event.id}`, c));

    const text = await readUntil(res, c, (t) => t.includes("event: door"));
    expect(text).toContain("Walk Up");
    // The unlinked row's email is the only handle the door has on it.
    expect(text).toContain("walkup@yale.edu");
    // The id is the revision, which the browser replays as Last-Event-ID.
    expect(text).toContain(`id: ${await attendanceRevision(event.id)}`);
  });

  it("sends nothing when the client is already up to date", async () => {
    const { door, event } = await fixture();
    await prisma.eventAttendance.create({
      data: {
        eventId: event.id,
        attendeeName: "Walk Up",
        attendeeEmail: "walkup@yale.edu",
        method: "WALK_UP",
      },
    });
    signedInAs(door.id);
    const rev = await attendanceRevision(event.id);
    const { GET } = await import("./route");
    const c = new AbortController();
    const res = await GET(open(`?event=${event.id}&rev=${encodeURIComponent(rev)}`, c));

    // Only the handshake and a heartbeat: an idle door with nothing new for this
    // client costs one small aggregate per tick and transfers no payload, which
    // is the whole reason change detection is a revision stamp.
    const text = await readUntil(res, c, (t) => t.includes(": connected"), 4_000);
    expect(text).not.toContain("event: door");
  });
});
