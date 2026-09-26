import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factories are hoisted above ordinary top-level const declarations, so
// the mocks referenced inside them must come from vi.hoisted().
const { auth, getActivePerson, assertBoardReadable, recordAudit, findTerm, findDepartment, loadRows, buildWorkbook } =
  vi.hoisted(() => ({
    auth: vi.fn(),
    getActivePerson: vi.fn(),
    assertBoardReadable: vi.fn(),
    recordAudit: vi.fn(),
    findTerm: vi.fn(),
    findDepartment: vi.fn(),
    loadRows: vi.fn(),
    buildWorkbook: vi.fn(),
  }));

vi.mock("@/platform/auth/auth", () => ({ auth }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson }));
vi.mock("@/platform/audit", () => ({ recordAudit }));
vi.mock("@/platform/db", () => ({
  prisma: { term: { findUnique: findTerm }, department: { findUnique: findDepartment } },
  isDbUnreachableError: () => false,
}));
vi.mock("@/modules/schedule/services/builder", () => {
  class BuilderForbiddenError extends Error {}
  return { assertBoardReadable, BuilderForbiddenError };
});
vi.mock("@/modules/schedule/services/schedule-export", () => ({
  loadScheduleExportRows: loadRows,
  buildScheduleWorkbook: buildWorkbook,
  scheduleExportFilename: (dept: string, term: string) => `${dept} schedule ${term}.xlsx`,
}));

import { GET } from "./route";
import { BuilderForbiddenError } from "@/modules/schedule/services/builder";

function request(query = "?term=t1&dept=d1"): Request {
  return new Request(`http://localhost/api/schedule/export${query}`);
}

beforeEach(() => {
  auth.mockReset().mockResolvedValue({ personId: "p1" });
  getActivePerson.mockReset().mockResolvedValue({ id: "p1" });
  assertBoardReadable.mockReset().mockResolvedValue(undefined);
  recordAudit.mockReset().mockResolvedValue(undefined);
  findTerm.mockReset().mockResolvedValue({ code: "FA26" });
  findDepartment.mockReset().mockResolvedValue({ code: "RHD" });
  loadRows.mockReset().mockResolvedValue([{}, {}]);
  buildWorkbook.mockReset().mockResolvedValue(Buffer.from("xlsx"));
});

describe("GET /api/schedule/export", () => {
  it("returns 401 without a session", async () => {
    auth.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
  });

  it("returns 400 without a term and department", async () => {
    expect((await GET(request("?term=t1"))).status).toBe(400);
  });

  it("returns 403 to someone who does not manage the department's schedule", async () => {
    assertBoardReadable.mockRejectedValue(new BuilderForbiddenError());
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect(assertBoardReadable).toHaveBeenCalledWith("p1", "d1");
    expect(loadRows).not.toHaveBeenCalled();
  });

  it("serves the workbook as a download and audits it", async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("spreadsheetml");
    expect(res.headers.get("Content-Disposition")).toContain("RHD schedule FA26.xlsx");
    expect(loadRows).toHaveBeenCalledWith("t1", "d1");
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorPersonId: "p1",
        action: "schedule.export",
        after: { termCode: "FA26", departmentCode: "RHD", rowCount: 2 },
      }),
    );
  });
});
