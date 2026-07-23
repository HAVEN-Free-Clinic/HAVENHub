import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

// Mock the auth + access resolution the route depends on, plus the blob read.
vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));
vi.mock("@/platform/rbac/engine", () => ({ can: vi.fn() }));
vi.mock("@/modules/learning/services/enrollment", () => ({ isCourseAssignedTo: vi.fn() }));
vi.mock("@/platform/storage", () => ({ getObject: vi.fn() }));

import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { can } from "@/platform/rbac/engine";
import { isCourseAssignedTo } from "@/modules/learning/services/enrollment";
import { getObject } from "@/platform/storage";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

function ctx(courseId: string, path: string[]) {
  return { params: Promise.resolve({ courseId, path }) };
}

async function seedAssignedLearner() {
  const person = await prisma.person.create({ data: { name: "Lee", contactEmail: "lee@yale.edu" } });
  const course = await prisma.course.create({
    data: { title: "HIPAA basics", scormBlobKey: "v1" },
  });
  mocked(auth).mockResolvedValue({ personId: person.id });
  mocked(getActivePerson).mockResolvedValue({ id: person.id });
  mocked(isCourseAssignedTo).mockResolvedValue(true);
  mocked(can).mockResolvedValue(false);
  mocked(getObject).mockResolvedValue(Buffer.from("<html><script>1</script></html>"));
  return { person, course };
}

describe("GET /learning/play/[courseId]/[...path]", () => {
  beforeEach(async () => {
    await resetDb();
    vi.resetAllMocks();
  });

  it("401s when unauthenticated", async () => {
    mocked(auth).mockResolvedValue(null);
    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/x"), ctx("c1", ["index.html"]));
    expect(res.status).toBe(401);
  });

  // This route serves EXECUTABLE uploaded content on the app's own origin, framed
  // with allow-same-origin so SCORM 1.2 can reach window.parent.API. Without a CSP,
  // a holder of learning.manage_courses could upload a package whose script reads
  // pages the learner can read and POSTs them off-origin.
  it("serves package files with a CSP that closes the off-origin exfiltration channels", async () => {
    const { course } = await seedAssignedLearner();
    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/x"), ctx(course.id, ["index.html"]));

    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("object-src 'none'");
    // No off-origin destination may be reachable from package script.
    expect(csp).not.toContain("*");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps the same-origin framing SCORM needs (frame-ancestors 'self', not 'none')", async () => {
    const { course } = await seedAssignedLearner();
    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/x"), ctx(course.id, ["index.html"]));
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
  });

  it("404s for an unassigned learner without learning.manage_courses", async () => {
    const { course } = await seedAssignedLearner();
    mocked(isCourseAssignedTo).mockResolvedValue(false);
    mocked(can).mockResolvedValue(false);
    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/x"), ctx(course.id, ["index.html"]));
    expect(res.status).toBe(404);
  });

  it("refuses path traversal", async () => {
    const { course } = await seedAssignedLearner();
    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/x"), ctx(course.id, ["..", "secrets"]));
    expect(res.status).toBe(404);
  });
});
