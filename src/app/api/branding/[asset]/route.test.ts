import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache } from "@/platform/settings/service";
import { saveBrandingAsset } from "@/platform/branding/assets";
import { GET } from "./route";

function ctx(asset: string) {
  return { params: Promise.resolve({ asset }) };
}

beforeEach(async () => { await resetDb(); _resetSettingsCache(); });

describe("GET /api/branding/[asset]", () => {
  it("404s for an unknown asset", async () => {
    const res = await GET(new Request("http://localhost/api/branding/bogus"), ctx("bogus"));
    expect(res.status).toBe(404);
  });

  it("redirects to the bundled default when no custom asset is set", async () => {
    const res = await GET(new Request("http://localhost/api/branding/logo"), ctx("logo"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/brand/haven-logo-white.png");
  });

  it("serves the stored bytes with content-type and nosniff when present", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await saveBrandingAsset("favicon", { name: "f.png", type: "image/png", size: bytes.length, bytes }, null);
    _resetSettingsCache();

    const res = await GET(new Request("http://localhost/api/branding/favicon"), ctx("favicon"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
  });
});
