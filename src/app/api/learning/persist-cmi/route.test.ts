import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));
vi.mock("@/platform/rbac/engine", () => ({ can: vi.fn() }));
vi.mock("@/modules/learning/services/enrollment", () => ({ persistScoCmi: vi.fn() }));

import { POST } from "./route";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { can } from "@/platform/rbac/engine";
import { persistScoCmi } from "@/modules/learning/services/enrollment";

const CMI = { lessonStatus: "completed", scoreRaw: 90, suspendData: null, lessonLocation: null };

function req(body: unknown): Request {
  return new Request("http://localhost/api/learning/persist-cmi", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function authed() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(auth).mockResolvedValue({ personId: "p1" } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(getActivePerson).mockResolvedValue({ id: "p1", status: "ACTIVE" } as any);
  vi.mocked(can).mockResolvedValue(true);
}

describe("POST /api/learning/persist-cmi", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401s and does not persist when unauthenticated", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(auth).mockResolvedValue(null as any);
    const res = await POST(req({ courseId: "c", scoId: "s", cmi: CMI }));
    expect(res.status).toBe(401);
    expect(persistScoCmi).not.toHaveBeenCalled();
  });

  it("403s and does not persist without learning.access", async () => {
    authed();
    vi.mocked(can).mockResolvedValue(false);
    const res = await POST(req({ courseId: "c", scoId: "s", cmi: CMI }));
    expect(res.status).toBe(403);
    expect(persistScoCmi).not.toHaveBeenCalled();
  });

  it("400s and does not persist on a malformed cmi", async () => {
    authed();
    const res = await POST(req({ courseId: "c", scoId: "s", cmi: { lessonStatus: 5 } }));
    expect(res.status).toBe(400);
    expect(persistScoCmi).not.toHaveBeenCalled();
  });

  it("persists with the SESSION personId (never the body's) and returns 204", async () => {
    authed();
    const res = await POST(
      // A crafted personId in the body must be ignored -- the write is scoped to the
      // authenticated session, so a beacon cannot forge another learner's progress.
      req({ courseId: "c1", scoId: "s1", cmi: CMI, personId: "attacker" }),
    );
    expect(res.status).toBe(204);
    expect(persistScoCmi).toHaveBeenCalledWith("p1", "c1", "s1", CMI);
  });
});
