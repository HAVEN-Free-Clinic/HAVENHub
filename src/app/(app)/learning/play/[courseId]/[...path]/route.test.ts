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

  // audit 14, scorm-asset-route-uncacheable. One course screen pulls the SCO
  // page plus every script, stylesheet, image and font it references, and each
  // of those requests used to cost five database queries and an R2 read because
  // the response forbade caching outright. The content is gated, so the answer
  // is a PRIVATE cache with a real lifetime, not a public one.
  it("lets the browser cache a package file privately", async () => {
    const { course } = await seedAssignedLearner();
    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/x"), ctx(course.id, ["index.html"]));

    const cacheControl = res.headers.get("cache-control") ?? "";
    expect(cacheControl).toContain("private");
    expect(cacheControl).not.toContain("public");
    expect(cacheControl).not.toContain("no-store");
    // The defect was max-age=0: a lifetime of zero is not a cache.
    const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1] ?? 0);
    expect(maxAge).toBeGreaterThan(0);
  });

  // The blob key changes on every re-ingest, so it identifies the exact bytes of
  // every file under it. A revalidation can therefore be answered without
  // touching storage at all.
  it("answers a matching If-None-Match with 304 and no storage read", async () => {
    const { course } = await seedAssignedLearner();
    const { GET } = await import("./route");

    const first = await GET(new Request("http://localhost/x"), ctx(course.id, ["index.html"]));
    const etag = first.headers.get("etag");
    expect(etag).toBe('"v1"');

    mocked(getObject).mockClear();
    const second = await GET(
      new Request("http://localhost/x", { headers: { "If-None-Match": etag! } }),
      ctx(course.id, ["index.html"]),
    );

    expect(second.status).toBe(304);
    expect(mocked(getObject)).not.toHaveBeenCalled();
  });

  // A stale validator must not be honored: after a re-upload the course points at
  // a new key, and the learner has to receive the new bytes.
  it("serves the file when If-None-Match names a superseded package", async () => {
    const { course } = await seedAssignedLearner();
    const { GET } = await import("./route");
    const res = await GET(
      new Request("http://localhost/x", { headers: { "If-None-Match": '"v0"' } }),
      ctx(course.id, ["index.html"]),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"v1"');
  });

  // Authorization still runs on every request, cache or no cache: a 304 is only
  // reachable after the same person/assignment checks as a 200.
  it("404s a revoked learner even when their browser holds a valid validator", async () => {
    const { course } = await seedAssignedLearner();
    mocked(isCourseAssignedTo).mockResolvedValue(false);
    mocked(can).mockResolvedValue(false);
    const { GET } = await import("./route");
    const res = await GET(
      new Request("http://localhost/x", { headers: { "If-None-Match": '"v1"' } }),
      ctx(course.id, ["index.html"]),
    );

    expect(res.status).toBe(404);
  });

  it("refuses path traversal", async () => {
    const { course } = await seedAssignedLearner();
    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/x"), ctx(course.id, ["..", "secrets"]));
    expect(res.status).toBe(404);
  });
});
