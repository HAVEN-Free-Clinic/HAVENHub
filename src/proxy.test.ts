import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { resolveProxy } from "./proxy";

const PORTAL_HOST = "apply.havenfreeclinic.org";

function req(host: string, path: string): NextRequest {
  return new NextRequest(`https://${host}${path}`, { headers: { host } });
}

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
});
