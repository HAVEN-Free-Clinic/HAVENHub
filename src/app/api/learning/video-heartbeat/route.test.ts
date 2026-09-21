import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));
vi.mock("@/modules/learning/services/video-progress", () => ({ recordSectionHeartbeat: vi.fn() }));

import { POST } from "./route";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { recordSectionHeartbeat } from "@/modules/learning/services/video-progress";
import { LearningAuthError, LearningValidationError } from "@/modules/learning/services/errors";

function req(body: unknown): Request {
  return new Request("http://localhost/api/learning/video-heartbeat", {
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
}

const BODY = { courseId: "c1", sectionId: "s1", reachedSeconds: 120 };

describe("POST /api/learning/video-heartbeat", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401s and records nothing when unauthenticated", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(auth).mockResolvedValue(null as any);
    const res = await POST(req(BODY));
    expect(res.status).toBe(401);
    expect(recordSectionHeartbeat).not.toHaveBeenCalled();
  });

  it("400s on a malformed body", async () => {
    authed();
    for (const body of [{}, { ...BODY, reachedSeconds: "120" }, { ...BODY, sectionId: 5 }]) {
      const res = await POST(req(body));
      expect(res.status).toBe(400);
    }
    expect(recordSectionHeartbeat).not.toHaveBeenCalled();
  });

  it("records against the session's person, never a person named in the body", async () => {
    authed();
    vi.mocked(recordSectionHeartbeat).mockResolvedValue({ watchedSeconds: 130, complete: false });
    const res = await POST(req({ ...BODY, personId: "someone-else" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ watchedSeconds: 130, complete: false });
    expect(recordSectionHeartbeat).toHaveBeenCalledWith("p1", "c1", "s1", 120);
  });

  it("turns a refusal into a status, not a 500", async () => {
    authed();
    vi.mocked(recordSectionHeartbeat).mockRejectedValueOnce(new LearningAuthError("nope"));
    expect((await POST(req(BODY))).status).toBe(403);
    vi.mocked(recordSectionHeartbeat).mockRejectedValueOnce(new LearningValidationError("later section"));
    expect((await POST(req(BODY))).status).toBe(409);
  });

  it("drops a heartbeat with 503 when the write conflict outlasts every retry", async () => {
    authed();
    const conflict = new Prisma.PrismaClientKnownRequestError("write conflict", { code: "P2034", clientVersion: "x" });
    vi.mocked(recordSectionHeartbeat).mockRejectedValueOnce(conflict);
    expect((await POST(req(BODY))).status).toBe(503);
  });

  it("still lets an unexpected error surface as a 500", async () => {
    authed();
    vi.mocked(recordSectionHeartbeat).mockRejectedValueOnce(new Error("boom"));
    await expect(POST(req(BODY))).rejects.toThrow("boom");
  });
});
