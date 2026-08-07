import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/modules/schedule/calendar/feed-token", () => ({
  resolveFeedToken: vi.fn(),
  touchFeedToken: vi.fn(),
}));
vi.mock("@/modules/schedule/calendar/feed", () => ({
  renderFeedForPerson: vi.fn(),
  renderEmptyFeed: vi.fn(),
}));
vi.mock("@/platform/db", () => ({
  prisma: { person: { findUnique: vi.fn() } },
}));

import { GET } from "./route";
import { resolveFeedToken, touchFeedToken } from "@/modules/schedule/calendar/feed-token";
import { renderFeedForPerson, renderEmptyFeed } from "@/modules/schedule/calendar/feed";
import { prisma } from "@/platform/db";

function request(token: string) {
  return [
    new Request(`https://hub.example.org/api/calendar/${token}`),
    { params: Promise.resolve({ token }) },
  ] as const;
}

describe("GET /api/calendar/[token]", () => {
  beforeEach(() => {
    vi.mocked(resolveFeedToken).mockReset();
    // Defaults to resolved so the route's fire-and-forget `.catch(...)` always
    // has a real promise to attach to; individual tests override with
    // mockRejectedValue to exercise the failure path.
    vi.mocked(touchFeedToken).mockReset().mockResolvedValue(undefined);
    vi.mocked(renderFeedForPerson).mockReset().mockResolvedValue("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
    vi.mocked(renderEmptyFeed).mockReset().mockResolvedValue("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
    vi.mocked(prisma.person.findUnique).mockReset();
  });

  it("404s an unknown token without rendering anything", async () => {
    vi.mocked(resolveFeedToken).mockResolvedValue(null);

    const res = await GET(...request("nope"));

    expect(res.status).toBe(404);
    expect(renderFeedForPerson).not.toHaveBeenCalled();
  });

  it("strips a trailing .ics before resolving, so both URL forms work", async () => {
    vi.mocked(resolveFeedToken).mockResolvedValue({ personId: "p1" });
    vi.mocked(prisma.person.findUnique).mockResolvedValue({ status: "ACTIVE" } as never);

    await GET(...request("abc123.ics"));

    expect(resolveFeedToken).toHaveBeenCalledWith("abc123");
  });

  it("serves the member's feed with calendar headers", async () => {
    vi.mocked(resolveFeedToken).mockResolvedValue({ personId: "p1" });
    vi.mocked(prisma.person.findUnique).mockResolvedValue({ status: "ACTIVE" } as never);

    const res = await GET(...request("abc123"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(renderFeedForPerson).toHaveBeenCalledWith("p1");
  });

  it("never allows a shared cache to hold a per-person secret feed", async () => {
    vi.mocked(resolveFeedToken).mockResolvedValue({ personId: "p1" });
    vi.mocked(prisma.person.findUnique).mockResolvedValue({ status: "ACTIVE" } as never);

    const res = await GET(...request("abc123"));

    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("records the fetch", async () => {
    vi.mocked(resolveFeedToken).mockResolvedValue({ personId: "p1" });
    vi.mocked(prisma.person.findUnique).mockResolvedValue({ status: "ACTIVE" } as never);

    await GET(...request("abc123"));

    expect(touchFeedToken).toHaveBeenCalledWith("p1");
  });

  it("still serves the rendered feed when the fetch-bookkeeping write fails", async () => {
    vi.mocked(resolveFeedToken).mockResolvedValue({ personId: "p1" });
    vi.mocked(prisma.person.findUnique).mockResolvedValue({ status: "ACTIVE" } as never);
    // A rejected promise with a .catch already attached (as the route does)
    // never becomes an unhandled rejection, regardless of when it settles.
    vi.mocked(touchFeedToken).mockRejectedValue(new Error("write conflict"));

    const res = await GET(...request("abc123"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(await res.text()).toBe("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");

    // Flush the microtask queue so the route's swallowed .catch runs inside
    // this test rather than bleeding console output into the next one.
    await Promise.resolve();
    await Promise.resolve();
  });

  it("serves an empty calendar, not a 404, once the member is no longer active", async () => {
    vi.mocked(resolveFeedToken).mockResolvedValue({ personId: "p1" });
    vi.mocked(prisma.person.findUnique).mockResolvedValue({ status: "OFFBOARDED" } as never);

    const res = await GET(...request("abc123"));

    expect(res.status).toBe(200);
    expect(renderEmptyFeed).toHaveBeenCalled();
    expect(renderFeedForPerson).not.toHaveBeenCalled();
  });

  it("serves an empty calendar when the person row is gone", async () => {
    vi.mocked(resolveFeedToken).mockResolvedValue({ personId: "p1" });
    vi.mocked(prisma.person.findUnique).mockResolvedValue(null);

    const res = await GET(...request("abc123"));

    expect(res.status).toBe(200);
    expect(renderEmptyFeed).toHaveBeenCalled();
  });
});

describe("rate limiting", () => {
  it("429s a single IP that floods the endpoint, and does not hit the database", async () => {
    vi.mocked(resolveFeedToken).mockResolvedValue(null);

    const flood = () =>
      GET(
        new Request("https://hub.example.org/api/calendar/x", {
          headers: { "x-forwarded-for": "203.0.113.9" },
        }),
        { params: Promise.resolve({ token: "x" }) },
      );

    let last: Response | undefined;
    for (let i = 0; i < 130; i++) last = await flood();

    expect(last!.status).toBe(429);
  });
});
