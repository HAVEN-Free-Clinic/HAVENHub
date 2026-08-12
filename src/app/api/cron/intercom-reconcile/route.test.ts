import { describe, expect, it, vi, afterEach } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("@/modules/support/services/intercom-reconcile", () => ({
  reconcileIntercomTickets: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/cron/intercom-reconcile", () => {
  it("rejects an unauthorized request with 401 and does not run the sweep", async () => {
    vi.stubEnv("CRON_SECRET", "sekret");
    const svc = await import("@/modules/support/services/intercom-reconcile");
    const { GET } = await import("./route");

    const res = await GET(new Request("https://x/api/cron/intercom-reconcile")); // no Authorization header

    expect(res.status).toBe(401);
    expect(svc.reconcileIntercomTickets).not.toHaveBeenCalled();
  });

  it("runs the sweep and reports its summary when the bearer token matches", async () => {
    vi.stubEnv("CRON_SECRET", "sekret");
    const svc = await import("@/modules/support/services/intercom-reconcile");
    vi.mocked(svc.reconcileIntercomTickets).mockResolvedValue({
      checked: 10,
      inSync: 8,
      mismatched: 1,
      unmappedIntercomState: 1,
      unreachable: 0,
    });
    const { GET } = await import("./route");

    const res = await GET(
      new Request("https://x/api/cron/intercom-reconcile", { headers: { Authorization: "Bearer sekret" } })
    );

    expect(res.status).toBe(200);
    expect(svc.reconcileIntercomTickets).toHaveBeenCalledOnce();
    expect(await res.json()).toEqual({
      ok: true,
      checked: 10,
      inSync: 8,
      mismatched: 1,
      unmappedIntercomState: 1,
      unreachable: 0,
    });
  });

  it("returns 503, not a crash, when the database is unreachable", async () => {
    vi.stubEnv("CRON_SECRET", "sekret");
    const svc = await import("@/modules/support/services/intercom-reconcile");
    vi.mocked(svc.reconcileIntercomTickets).mockRejectedValue(
      new Prisma.PrismaClientInitializationError(
        "Can't reach database server at ep-broad-brook.neon.tech:5432",
        "5.0.0"
      )
    );
    const { GET } = await import("./route");

    const res = await GET(
      new Request("https://x/api/cron/intercom-reconcile", { headers: { Authorization: "Bearer sekret" } })
    );

    expect(res.status).toBe(503);
  });

  it("rethrows a non-connectivity error rather than reporting a false success", async () => {
    vi.stubEnv("CRON_SECRET", "sekret");
    const svc = await import("@/modules/support/services/intercom-reconcile");
    vi.mocked(svc.reconcileIntercomTickets).mockRejectedValue(new Error("boom"));
    const { GET } = await import("./route");

    await expect(
      GET(new Request("https://x/api/cron/intercom-reconcile", { headers: { Authorization: "Bearer sekret" } }))
    ).rejects.toThrow("boom");
  });
});
