import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const isBlockedByMaintenance = vi.hoisted(() => vi.fn(async () => false));
vi.mock("@/platform/maintenance/request-gate", () => ({ isBlockedByMaintenance }));

import { resolveProxy, proxy } from "./proxy";

const PORTAL_HOST = "apply.havenfreeclinic.org";

function req(host: string, path: string): NextRequest {
  return new NextRequest(`https://${host}${path}`, { headers: { host } });
}

beforeEach(() => isBlockedByMaintenance.mockImplementation(async () => false));
afterEach(() => vi.clearAllMocks());

describe("resolveProxy", () => {
  it("rewrites the portal root and slugs onto /apply", () => {
    expect(resolveProxy(req(PORTAL_HOST, "/"), PORTAL_HOST).headers.get("x-middleware-rewrite"))
      .toContain("/apply");
    const slug = resolveProxy(req(PORTAL_HOST, "/fall-2026"), PORTAL_HOST);
    expect(slug.headers.get("x-middleware-rewrite")).toContain("/apply/fall-2026");
  });

  it("preserves the query string on rewrite", () => {
    const res = resolveProxy(req(PORTAL_HOST, "/fall-2026?type=renewal"), PORTAL_HOST);
    expect(res.headers.get("x-middleware-rewrite")).toContain("/apply/fall-2026?type=renewal");
  });

  it("passes through auth, api, existing /apply, and assets on the portal host", () => {
    for (const p of ["/login", "/api/auth/callback/x", "/apply/fall-2026", "/brand/login-building.webp"]) {
      expect(resolveProxy(req(PORTAL_HOST, p), PORTAL_HOST).headers.get("x-middleware-rewrite")).toBeNull();
    }
  });

  it("never rewrites on a non-portal host", () => {
    expect(resolveProxy(req("hub.example.org", "/fall-2026"), PORTAL_HOST).headers.get("x-middleware-rewrite")).toBeNull();
    expect(resolveProxy(req("hub.example.org", "/fall-2026"), null).headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("leaves /maintenance alone on the portal host, so the redirect can resolve", () => {
    // Without "maintenance" in RESERVED_PORTAL_SLUGS this rewrites onto
    // /apply/maintenance and a portal visitor gets a 404 instead of the page.
    expect(
      resolveProxy(req(PORTAL_HOST, "/maintenance"), PORTAL_HOST).headers.get("x-middleware-rewrite")
    ).toBeNull();
  });
});

describe("proxy", () => {
  it("redirects a blocked request to /maintenance on the host it arrived at", async () => {
    isBlockedByMaintenance.mockImplementation(async () => true);
    const res = await proxy(req(PORTAL_HOST, "/fall-2026"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`https://${PORTAL_HOST}/maintenance`);
  });

  it("falls through to the normal rewrite/pass-through when nothing is blocked", async () => {
    const res = await proxy(req("hub.example.org", "/dashboard"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });
});
