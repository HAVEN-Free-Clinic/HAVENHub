import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock every collaborator so this exercises the route's auth + serving logic
// alone, with no database.
vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));
vi.mock("@/platform/rbac/engine", () => ({ can: vi.fn() }));
vi.mock("@/platform/storage", () => ({ getObject: vi.fn() }));
vi.mock("@/modules/recruitment/services/onboarding", () => ({ getContractHipaa: vi.fn() }));

import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { can } from "@/platform/rbac/engine";
import { getObject } from "@/platform/storage";
import { getContractHipaa } from "@/modules/recruitment/services/onboarding";

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

async function call(opts: { url?: string; contractId?: string } = {}) {
  const url = opts.url ?? "https://hub.test/api/recruitment/onboarding/c1/hipaa";
  const { GET } = await import("./route");
  return GET(new Request(url), { params: Promise.resolve({ contractId: opts.contractId ?? "c1" }) });
}

describe("GET /api/recruitment/onboarding/[contractId]/hipaa", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock(auth).mockResolvedValue({ personId: "p1" });
    mock(getActivePerson).mockResolvedValue({ id: "p1" });
    mock(can).mockResolvedValue(true);
    mock(getContractHipaa).mockResolvedValue({
      hipaaStoredName: "hipaa-12345678-1234-1234-1234-123456789abc.pdf",
      hipaaFileName: "My HIPAA.pdf",
      hipaaMimeType: "application/pdf",
    });
    mock(getObject).mockResolvedValue(Buffer.from("PDFDATA"));
  });

  it("401s when unauthenticated", async () => {
    mock(auth).mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });

  it("401s when the session has no active person", async () => {
    mock(getActivePerson).mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });

  it("404s a reviewer without recruitment.review_all", async () => {
    mock(can).mockImplementation((_id: string, perm: string) => Promise.resolve(perm !== "recruitment.review_all"));
    const res = await call();
    expect(res.status).toBe(404);
    expect(mock(getObject)).not.toHaveBeenCalled();
  });

  it("404s when the contract does not exist", async () => {
    mock(getContractHipaa).mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });

  it("404s when the contract has no stored certificate", async () => {
    mock(getContractHipaa).mockResolvedValue({ hipaaStoredName: null, hipaaFileName: null, hipaaMimeType: null });
    expect((await call()).status).toBe(404);
  });

  it("404s a storedName that is not the server-generated format (path traversal)", async () => {
    mock(getContractHipaa).mockResolvedValue({
      hipaaStoredName: "../../secrets.pdf",
      hipaaFileName: "x.pdf",
      hipaaMimeType: "application/pdf",
    });
    const res = await call();
    expect(res.status).toBe(404);
    expect(mock(getObject)).not.toHaveBeenCalled();
  });

  it("404s when the object is missing from storage", async () => {
    mock(getObject).mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });

  it("serves the certificate bytes as a download by default", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("PDFDATA");
    // Key is built from the contract id + the server-stored name.
    expect(mock(getObject)).toHaveBeenCalledWith("onboarding/c1/hipaa-12345678-1234-1234-1234-123456789abc.pdf");
  });

  it("renders inline when ?inline=1 and the mime type is preview-safe", async () => {
    const res = await call({ url: "https://hub.test/api/recruitment/onboarding/c1/hipaa?inline=1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("inline");
  });

  it("forces a download for an unsafe mime type even when inline is requested", async () => {
    mock(getContractHipaa).mockResolvedValue({
      hipaaStoredName: "hipaa-12345678-1234-1234-1234-123456789abc.html",
      hipaaFileName: "x.html",
      hipaaMimeType: "text/html",
    });
    const res = await call({ url: "https://hub.test/api/recruitment/onboarding/c1/hipaa?inline=1" });
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
  });
});
