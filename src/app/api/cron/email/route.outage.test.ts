/**
 * Regression test for issue #63: one cron tick must not burn the whole retry
 * budget when the email transport is down for the entire tick.
 *
 * Auth, campaign dispatch, and transport resolution are mocked so we can inject
 * a deterministically-failing transport; the REAL drainEmailQueue runs against
 * the test database, so we observe the actual per-row attempt accounting after
 * a single GET. (Kept separate from route.test.ts, whose tests rely on the real
 * log transport -- vi.mock is file-scoped.)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

vi.mock("@/platform/cron", () => ({ authorizeCron: vi.fn(() => true) }));
vi.mock("@/platform/email/campaigns/dispatch", () => ({
  dispatchDueCampaigns: vi.fn(async () => ({ executed: 0, errors: [] })),
}));
vi.mock("@/platform/email/transport", () => ({ resolveEmailTransport: vi.fn() }));
vi.mock("@/platform/notifications/teams-transport", () => ({
  resolveTeamsTransport: vi.fn(),
}));

import { resolveEmailTransport } from "@/platform/email/transport";
import { resolveTeamsTransport } from "@/platform/notifications/teams-transport";

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function cronRequest(): Request {
  return new Request("http://localhost/api/cron/email");
}

async function seedQueued(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await prisma.emailLog.create({
      data: {
        toEmail: `user${i}@example.com`,
        subject: "Hi",
        html: "<p>x</p>",
        template: "generic",
        createdAt: new Date(Date.now() + i * 1000),
      },
    });
  }
}

describe("GET /api/cron/email: retry-budget protection (issue #63)", () => {
  beforeEach(async () => {
    await resetDb();
    vi.clearAllMocks();
    // Teams queue is empty here; give it a harmless stub transport.
    asMock(resolveTeamsTransport).mockResolvedValue({ send: vi.fn() });
  });

  it("attempts each queued email only once when the transport is down all tick", async () => {
    asMock(resolveEmailTransport).mockResolvedValue({
      send: vi.fn(async () => {
        throw new Error("graph down");
      }),
    });
    await seedQueued(5);

    const { GET } = await import("./route");
    const res = await GET(cronRequest());
    expect(res.status).toBe(200);

    // Still QUEUED with exactly one attempt -- NOT FAILED at attempts == 8. A
    // later tick (after recovery) retries them, one attempt per minute.
    const rows = await prisma.emailLog.findMany();
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.status).toBe("QUEUED");
      expect(row.attempts).toBe(1);
    }
    expect(await prisma.emailLog.count({ where: { status: "FAILED" } })).toBe(0);
  });

  it("delivers the whole queue in one tick when the transport is healthy", async () => {
    const send = vi.fn(async () => {});
    asMock(resolveEmailTransport).mockResolvedValue({ send });
    await seedQueued(5);

    const { GET } = await import("./route");
    const res = await GET(cronRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.emails).toBe(5);
    expect(send).toHaveBeenCalledTimes(5);
    expect(await prisma.emailLog.count({ where: { status: "SENT" } })).toBe(5);
  });
});
