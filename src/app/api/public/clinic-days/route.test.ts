import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { GET, OPTIONS } from "./route";

// The calendar rules are covered against a real database in
// platform/terms/public-clinic-days.test.ts. This file is about the HTTP surface
// -- status codes, headers, and query handling -- so the query is stubbed.
const mocks = vi.hoisted(() => ({ publicClinicDays: vi.fn() }));
vi.mock("@/platform/terms/public-clinic-days", () => ({
  publicClinicDays: mocks.publicClinicDays,
}));

const DAYS = [
  { date: "2026-08-22", specialty: "Dermatology" },
  { date: "2026-08-29", specialty: null },
];

function get(url = "https://hub.example/api/public/clinic-days") {
  return GET(new Request(url));
}

beforeEach(() => {
  mocks.publicClinicDays.mockResolvedValue(DAYS);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/public/clinic-days", () => {
  it("returns the schedule as JSON", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clinicDays: DAYS });
  });

  it("is readable cross-origin and cacheable at the edge", async () => {
    const res = await get();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toContain("s-maxage=300");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("defaults to four days", async () => {
    await get();
    expect(mocks.publicClinicDays).toHaveBeenCalledWith(4);
  });

  it("honours an explicit limit", async () => {
    await get("https://hub.example/api/public/clinic-days?limit=8");
    expect(mocks.publicClinicDays).toHaveBeenCalledWith(8);
  });

  it("clamps a limit above the ceiling", async () => {
    await get("https://hub.example/api/public/clinic-days?limit=9999");
    expect(mocks.publicClinicDays).toHaveBeenCalledWith(26);
  });

  it.each(["0", "-3", "abc", "2.5", ""])(
    "falls back to the default for limit=%s",
    async (raw) => {
      await get(`https://hub.example/api/public/clinic-days?limit=${raw}`);
      expect(mocks.publicClinicDays).toHaveBeenCalledWith(4);
    }
  );

  it("returns an empty array rather than an error when nothing is scheduled", async () => {
    mocks.publicClinicDays.mockResolvedValue([]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clinicDays: [] });
  });

  it("degrades to 503, uncached, when the database is unreachable", async () => {
    mocks.publicClinicDays.mockRejectedValue(
      new Prisma.PrismaClientInitializationError("unreachable", "0.0.0")
    );
    const res = await get();
    expect(res.status).toBe(503);
    // A cached 503 would keep the website on its fallback long after the
    // database came back.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("lets an unexpected error surface rather than reporting a false 503", async () => {
    mocks.publicClinicDays.mockRejectedValue(new Error("boom"));
    await expect(get()).rejects.toThrow("boom");
  });
});

describe("OPTIONS /api/public/clinic-days", () => {
  it("answers preflight with the allowed methods", async () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });
});
