/**
 * Integration tests for the builder's change stream.
 *
 * Two things matter here and neither is the streaming machinery: that the stream
 * is gated by the same department authority the board itself is (it carries every
 * assignee's name out of the database), and that it pushes a snapshot exactly
 * when the board has moved past what the client says it has seen.
 *
 * Each test that opens the stream aborts it as soon as it has what it needs; the
 * route otherwise runs for minutes by design.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { isoDateKey } from "@/platform/dates";
import { boardRevision } from "@/modules/schedule/services/builder";

vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));

import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

function utcNoon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

const SATURDAY = utcNoon(2026, 6, 6);
const DATE_KEY = isoDateKey(SATURDAY);
/** Mirrors the route's own tick, so the quiet-stream test waits a few of them. */
const TICK_MS = 2_000;

async function fixture() {
  const term = await prisma.term.create({
    data: {
      code: `SU26-${Date.now()}-${Math.random()}`,
      name: "Summer 2026",
      startDate: utcNoon(2026, 5, 30),
      endDate: utcNoon(2026, 9, 26),
      status: "ACTIVE",
      clinicDates: [SATURDAY],
    },
  });
  const dept = await prisma.department.upsert({
    where: { code: "MED" },
    update: {},
    create: { code: "MED", name: "Medicine" },
  });
  const other = await prisma.department.upsert({
    where: { code: "VADM" },
    update: {},
    create: { code: "VADM", name: "Vaccine Administration" },
  });
  const director = await prisma.person.create({ data: { name: "Dana Director" } });
  const volunteer = await prisma.person.create({ data: { name: "Vic Volunteer" } });
  const outsider = await prisma.person.create({ data: { name: "Otto Outsider" } });

  for (const [person, kind, department] of [
    [director, "DIRECTOR", dept],
    [volunteer, "VOLUNTEER", dept],
    [outsider, "DIRECTOR", other],
  ] as const) {
    await prisma.termMembership.create({
      data: {
        personId: person.id,
        termId: term.id,
        departmentId: department.id,
        kind,
        status: "ACTIVE",
        baselineAvailability: [],
        selfAvailabilityDates: [],
        directorAvailabilityDates: [],
      },
    });
  }
  return { term, dept, director, volunteer, outsider };
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
  return new Request(`http://localhost/api/schedule/builder/stream${params}`, {
    signal: controller.signal,
  });
}

describe("GET /api/schedule/builder/stream", () => {
  beforeEach(async () => {
    await resetDb();
    vi.resetAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    mocked(auth).mockResolvedValue(null);
    const { GET } = await import("./route");
    const c = new AbortController();
    expect((await GET(open("?term=t&dept=d", c))).status).toBe(401);
  });

  it("returns 400 without a term and department", async () => {
    const { director } = await fixture();
    signedInAs(director.id);
    const { GET } = await import("./route");
    const c = new AbortController();
    expect((await GET(open("", c))).status).toBe(400);
  });

  // The stream carries every assignee's name, so it needs the same authority the
  // board does, not merely a signed-in session.
  it("returns 403 for a department the viewer does not manage", async () => {
    const { term, dept, outsider } = await fixture();
    signedInAs(outsider.id);
    const { GET } = await import("./route");
    const c = new AbortController();
    const res = await GET(open(`?term=${term.id}&dept=${dept.id}`, c));
    expect(res.status).toBe(403);
  });

  it("opens as an event stream for a department the viewer manages", async () => {
    const { term, dept, director } = await fixture();
    signedInAs(director.id);
    const { GET } = await import("./route");
    const c = new AbortController();
    const res = await GET(open(`?term=${term.id}&dept=${dept.id}`, c));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    // Without this, a proxy buffers the whole response and delivers nothing
    // until the stream ends -- which for a stream that runs for minutes means
    // nothing at all.
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");

    const text = await readUntil(res, c, (t) => t.includes(": connected"));
    expect(text).toContain("retry: 3000");
  });

  it("pushes the board when the client's revision is behind", async () => {
    const { term, dept, director, volunteer } = await fixture();
    await prisma.shiftAssignment.create({
      data: {
        termId: term.id,
        departmentId: dept.id,
        personId: volunteer.id,
        clinicDate: SATURDAY,
        role: "SHADOW",
      },
    });
    signedInAs(director.id);
    const { GET } = await import("./route");
    const c = new AbortController();
    // "0:0" is what an empty board stamps to, so this client is a whole
    // assignment behind.
    const res = await GET(open(`?term=${term.id}&dept=${dept.id}&rev=0%3A0`, c));

    const text = await readUntil(res, c, (t) => t.includes("event: board"));
    const payload = JSON.parse(text.split("data: ")[1].split("\n")[0]);
    expect(payload.assignments[DATE_KEY][volunteer.id].role).toBe("SHADOW");
    // The id is what the browser replays as Last-Event-ID on reconnect, so a
    // reconnect that finds nothing changed sends nothing.
    expect(text).toContain(`id: ${payload.revision}`);
  });

  // A reconnecting client that is already current must not be handed the board
  // again: with a stream rolling over every few minutes per viewer, that is the
  // difference between a heartbeat and a broadcast.
  it("sends no board when the client is already current", async () => {
    const { term, dept, director, volunteer } = await fixture();
    await prisma.shiftAssignment.create({
      data: {
        termId: term.id,
        departmentId: dept.id,
        personId: volunteer.id,
        clinicDate: SATURDAY,
        role: "VOLUNTEER",
      },
    });
    const current = await boardRevision(term.id, dept.id);
    signedInAs(director.id);
    const { GET } = await import("./route");
    const c = new AbortController();
    const res = await GET(
      open(`?term=${term.id}&dept=${dept.id}&rev=${encodeURIComponent(current)}`, c),
    );

    // Let it run for several ticks, then close it from this end and read
    // whatever it managed to say. A time-boxed read is the only way to assert an
    // absence on a stream that is supposed to stay quiet.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const stop = setTimeout(() => c.abort(), 6 * TICK_MS);
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      clearTimeout(stop);
      await reader.cancel().catch(() => {});
    }

    expect(text).toContain(": connected");
    expect(text).not.toContain("event: board");
  }, 20_000);
});
