import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { jwtVerify } from "jose";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

// Mock the auth + person resolution the route depends on.
vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));

import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";

const SECRET = "test-messenger-secret";
const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

/** Both env vars set = the feature is on. Individual tests unset one to check the gate. */
function configure() {
  vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
  vi.stubEnv("INTERCOM_MESSENGER_SECRET", SECRET);
}

describe("GET /api/support/messenger-token", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    configure();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("404s when the integration is not configured", async () => {
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "");
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it("404s when only the app id is set, rather than booting an unverified Messenger", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "");
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it("returns 401 when unauthenticated", async () => {
    mocked(auth).mockResolvedValue(null);
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns 401 for an offboarded person whose hub session is still valid", async () => {
    mocked(auth).mockResolvedValue({ personId: "p1" });
    mocked(getActivePerson).mockResolvedValue(null);
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("mints a token whose user_id is the server-resolved Person id", async () => {
    mocked(auth).mockResolvedValue({ personId: "p1" });
    mocked(getActivePerson).mockResolvedValue({
      id: "p1",
      name: "Sam Rivera",
      contactEmail: "sam@example.com",
    });

    const { GET } = await import("./route");
    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(json.expiresInSeconds).toBeGreaterThan(0);

    const { payload } = await jwtVerify(json.token, new TextEncoder().encode(SECRET));
    expect(payload.user_id).toBe("p1");
    expect(payload.email).toBe("sam@example.com");
  });

  it("returns 503 when the database is unreachable resolving the person", async () => {
    mocked(auth).mockResolvedValue({ personId: "p1" });
    mocked(getActivePerson).mockRejectedValue(
      new Prisma.PrismaClientInitializationError(
        "Can't reach database server at ep-broad-brook.neon.tech:5432",
        "5.0.0"
      )
    );

    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(503);
  });

  // No active term exists in the (reset) test DB for these, so getOnboardingStatus
  // short-circuits before ever touching the Person table -- safe to use a mocked
  // person id with no matching DB row, same as the "mints a token" test above.
  describe("profile claims (no active term)", () => {
    it("carries Epic ID, Yale NetID, and Member status when present", async () => {
      mocked(auth).mockResolvedValue({ personId: "p1" });
      mocked(getActivePerson).mockResolvedValue({
        id: "p1",
        name: "Sam Rivera",
        contactEmail: "sam@example.com",
        epicId: "E12345",
        netId: "sr123",
        status: "ACTIVE",
      });

      const { GET } = await import("./route");
      const res = await GET();
      const json = await res.json();

      const { payload } = await jwtVerify(json.token, new TextEncoder().encode(SECRET));
      expect(payload["Epic ID"]).toBe("E12345");
      expect(payload["Yale NetID"]).toBe("sr123");
      expect(payload["Member status"]).toBe("ACTIVE");
    });

    it("omits Epic ID rather than sending an empty one when the person has none", async () => {
      mocked(auth).mockResolvedValue({ personId: "p1" });
      mocked(getActivePerson).mockResolvedValue({
        id: "p1",
        name: "Sam Rivera",
        contactEmail: "sam@example.com",
        epicId: null,
        netId: "sr123",
        status: "ACTIVE",
      });

      const { GET } = await import("./route");
      const res = await GET();
      const json = await res.json();

      const { payload } = await jwtVerify(json.token, new TextEncoder().encode(SECRET));
      expect("Epic ID" in payload).toBe(false);
    });

    it("omits Active term, Departments, and Clearance at last sign-in when there is no active clinic term", async () => {
      mocked(auth).mockResolvedValue({ personId: "p1" });
      mocked(getActivePerson).mockResolvedValue({
        id: "p1",
        name: "Sam Rivera",
        contactEmail: "sam@example.com",
        epicId: null,
        netId: null,
        status: "ACTIVE",
      });

      const { GET } = await import("./route");
      const res = await GET();
      const json = await res.json();

      const { payload } = await jwtVerify(json.token, new TextEncoder().encode(SECRET));
      expect("Active term" in payload).toBe(false);
      expect("Departments" in payload).toBe(false);
      expect("Clearance at last sign-in" in payload).toBe(false);
    });

    it("still sends every audience flag, including false, alongside the profile claims", async () => {
      mocked(auth).mockResolvedValue({ personId: "p1" });
      mocked(getActivePerson).mockResolvedValue({
        id: "p1",
        name: "Sam Rivera",
        contactEmail: "sam@example.com",
        epicId: null,
        netId: null,
        status: "ACTIVE",
      });

      const { GET } = await import("./route");
      const res = await GET();
      const json = await res.json();

      const { payload } = await jwtVerify(json.token, new TextEncoder().encode(SECRET));
      // A person with no grants holds none of the seven Hub audience flags,
      // and every one of them must still be PRESENT and false (see audience.ts).
      expect(payload["Hub admin access"]).toBe(false);
      expect(payload["Hub support manage"]).toBe(false);
    });
  });

  describe("profile claims (with an active term)", () => {
    beforeEach(resetDb);

    it("carries Active term, Departments, and Clearance at last sign-in from the live term state", async () => {
      const person = await prisma.person.create({
        data: { name: "Sam Rivera", contactEmail: "sam@example.com", netId: "sr123", status: "ACTIVE" },
      });
      const term = await prisma.term.create({
        data: {
          code: "SU26",
          name: "Summer 2026",
          startDate: new Date("2026-05-01"),
          endDate: new Date("2026-09-26"),
          status: "ACTIVE",
        },
      });
      const dept = await prisma.department.create({ data: { code: "JCTP", name: "JCTP Dept" } });
      await prisma.termMembership.create({
        data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
      });

      mocked(auth).mockResolvedValue({ personId: person.id });
      mocked(getActivePerson).mockResolvedValue(person);

      const { GET } = await import("./route");
      const res = await GET();
      const json = await res.json();

      const { payload } = await jwtVerify(json.token, new TextEncoder().encode(SECRET));
      expect(payload["Active term"]).toBe("Summer 2026");
      expect(payload["Departments"]).toBe("JCTP Dept");
      // The exact Cleared/Not cleared value depends on the onboarding engine's
      // own rules (out of scope here -- see the onboarding module's tests);
      // this only checks that the sync actually reached and reused it.
      expect(["Cleared", "Not cleared"]).toContain(payload["Clearance at last sign-in"]);
    });
  });
});
