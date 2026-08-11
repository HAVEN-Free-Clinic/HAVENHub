import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { jwtVerify } from "jose";

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

describe("GET /api/intercom/token", () => {
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
});
