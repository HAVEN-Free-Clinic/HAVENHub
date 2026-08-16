import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted above ordinary top-level const declarations, so
// the mocks referenced inside them must come from vi.hoisted() (see
// src/platform/storage/r2.test.ts for the same pattern).
const { auth, getActivePerson, can, presignPut, storageMock } = vi.hoisted(() => ({
  auth: vi.fn(),
  getActivePerson: vi.fn(),
  can: vi.fn(),
  presignPut: vi.fn(),
  storageMock: { supportsPresignedUpload: true },
}));

vi.mock("@/platform/auth/auth", () => ({ auth }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson }));
vi.mock("@/platform/rbac/engine", () => ({ can }));
vi.mock("@/platform/storage/r2", () => ({ presignPut }));
// Getter, not a plain value: route.ts reads supportsPresignedUpload once per
// request, and beforeEach below flips storageMock between tests without
// re-importing the route module.
vi.mock("@/platform/storage", () => ({
  get supportsPresignedUpload() {
    return storageMock.supportsPresignedUpload;
  },
}));

import { POST } from "./route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/learning/upload-url", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const valid = {
  courseId: "course-1",
  filename: "package.zip",
  contentType: "application/zip",
  size: 1024,
};

beforeEach(() => {
  auth.mockReset().mockResolvedValue({ personId: "p1" });
  getActivePerson.mockReset().mockResolvedValue({ id: "p1" });
  can.mockReset().mockResolvedValue(true);
  presignPut.mockReset().mockResolvedValue("https://signed.example/put");
  storageMock.supportsPresignedUpload = true;
});

describe("POST /api/learning/upload-url", () => {
  it("returns a signed URL and key for a course manager", async () => {
    const res = await POST(request(valid));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.url).toBe("https://signed.example/put");
    expect(json.key).toMatch(/^scorm-uploads\/course-1\/[0-9a-f-]+-package\.zip$/);
  });

  it("signs with the same content type the client will send", async () => {
    // Content-Type is not part of the presigned signature (R2 accepts a
    // mismatch there rather than rejecting it), but it is stored as the
    // object's content type exactly as sent. Signing with the same value the
    // client sends is what keeps that stored type correct, not what prevents a
    // signature failure.
    await POST(request(valid));
    expect(presignPut).toHaveBeenCalledWith(
      expect.stringContaining("scorm-uploads/course-1/"),
      "application/zip",
      600
    );
  });

  it("rejects an anonymous caller", async () => {
    auth.mockResolvedValue(null);
    const res = await POST(request(valid));
    expect(res.status).toBe(403);
    expect(presignPut).not.toHaveBeenCalled();
  });

  it("rejects a signed-in user without learning.manage_courses", async () => {
    can.mockResolvedValue(false);
    const res = await POST(request(valid));
    expect(res.status).toBe(403);
    expect(presignPut).not.toHaveBeenCalled();
  });

  it("fails cleanly with 503 when R2 is not configured, without calling presignPut", async () => {
    // The rolled-back state: R2_* unset, so presignPut would build its request
    // from undefined bucket/account/credentials. UploadPackageForm already
    // gates its direct-upload path on supportsPresignedUpload and should never
    // reach here, but a stale client or a direct request still can.
    storageMock.supportsPresignedUpload = false;
    const res = await POST(request(valid));
    expect(res.status).toBe(503);
    expect(presignPut).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared size", async () => {
    const res = await POST(request({ ...valid, size: 80 * 1024 * 1024 }));
    expect(res.status).toBe(400);
    expect(presignPut).not.toHaveBeenCalled();
  });

  it("rejects a disallowed content type", async () => {
    const res = await POST(request({ ...valid, contentType: "text/html" }));
    expect(res.status).toBe(400);
    expect(presignPut).not.toHaveBeenCalled();
  });

  it("rejects a courseId that could escape the key namespace", async () => {
    // courseId is interpolated straight into the object key. A traversal value
    // would let a manager write outside scorm-uploads/.
    const res = await POST(request({ ...valid, courseId: "../../branding" }));
    expect(res.status).toBe(400);
    expect(presignPut).not.toHaveBeenCalled();
  });

  it("sanitizes a hostile filename into the key", async () => {
    const res = await POST(request({ ...valid, filename: "../../etc/passwd" }));
    expect(res.status).toBe(200);
    const { key } = await res.json();
    expect(key).not.toContain("..");
    expect(key.startsWith("scorm-uploads/course-1/")).toBe(true);
  });

  it("rejects a malformed body", async () => {
    const res = await POST(request({ courseId: "course-1" }));
    expect(res.status).toBe(400);
    expect(presignPut).not.toHaveBeenCalled();
  });
});
