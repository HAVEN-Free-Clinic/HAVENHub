import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted above ordinary top-level const declarations, so
// the mocks referenced inside them must come from vi.hoisted().
const { auth, getActivePerson, can, buildOffboardingCsv, recordAudit } = vi.hoisted(() => ({
  auth: vi.fn(),
  getActivePerson: vi.fn(),
  can: vi.fn(),
  buildOffboardingCsv: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("@/platform/auth/auth", () => ({ auth }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson }));
vi.mock("@/platform/rbac/engine", () => ({ can }));
vi.mock("@/platform/audit", () => ({ recordAudit }));
vi.mock("@/modules/volunteers/services/offboarding-export", () => ({ buildOffboardingCsv }));

import { POST } from "./route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/volunteers/offboarding/export", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  auth.mockReset().mockResolvedValue({ personId: "p1" });
  getActivePerson.mockReset().mockResolvedValue({ id: "p1" });
  can.mockReset().mockResolvedValue(true);
  recordAudit.mockReset().mockResolvedValue(undefined);
  buildOffboardingCsv.mockReset().mockResolvedValue({
    filename: "haven-offboarding-FA25-2026-08-07.csv",
    csv: "Name,Email\r\nJane,jane@yale.edu",
    rowCount: 1,
  });
});

describe("POST /api/volunteers/offboarding/export", () => {
  it("returns 401 without a session", async () => {
    auth.mockResolvedValue(null);
    const res = await POST(request({ scope: "offboarded-term" }));
    expect(res.status).toBe(401);
  });

  it("returns 401 without volunteers.manage_offboarding", async () => {
    can.mockResolvedValue(false);
    const res = await POST(request({ scope: "offboarded-term" }));
    expect(res.status).toBe(401);
    expect(can).toHaveBeenCalledWith("p1", "volunteers.manage_offboarding");
  });

  it("returns 400 for an unknown scope", async () => {
    const res = await POST(request({ scope: "everything" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for a selection with no person ids", async () => {
    const res = await POST(request({ scope: "selection", personIds: [] }));
    expect(res.status).toBe(400);
  });

  it("serves the CSV as an attachment for the offboarded-term scope", async () => {
    const res = await POST(request({ scope: "offboarded-term" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toContain(
      'filename="haven-offboarding-FA25-2026-08-07.csv"'
    );
    expect(await res.text()).toBe("Name,Email\r\nJane,jane@yale.edu");
    expect(buildOffboardingCsv).toHaveBeenCalledWith(
      { scope: "offboarded-term" },
      expect.any(Date)
    );
  });

  it("passes the selected ids through and audits the export", async () => {
    const res = await POST(request({ scope: "selection", personIds: ["a", "b"] }));

    expect(res.status).toBe(200);
    expect(buildOffboardingCsv).toHaveBeenCalledWith(
      { scope: "selection", personIds: ["a", "b"] },
      expect.any(Date)
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorPersonId: "p1",
        action: "offboarding.export",
        after: { scope: "selection", rowCount: 1 },
      })
    );
  });
});
