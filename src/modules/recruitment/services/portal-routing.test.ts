import { describe, it, expect } from "vitest";
import {
  RESERVED_PORTAL_SLUGS,
  hostFromUrl,
  isPortalPassThrough,
  rewriteToApply,
  isReservedSlug,
  buildPortalUrl,
  pickPortalEmailBase,
} from "./portal-routing";

describe("hostFromUrl", () => {
  it("returns the host for a valid url", () => {
    expect(hostFromUrl("https://apply.havenfreeclinic.org")).toBe("apply.havenfreeclinic.org");
  });
  it("returns null for empty or invalid input", () => {
    expect(hostFromUrl(undefined)).toBeNull();
    expect(hostFromUrl("")).toBeNull();
    expect(hostFromUrl("not a url")).toBeNull();
  });
});

describe("isPortalPassThrough", () => {
  it("passes through app, auth, assets, and reserved first segments", () => {
    for (const p of ["/apply", "/apply/fall-2026", "/api/auth/callback/x", "/login", "/_next/x", "/brand/login-building.webp", "/favicon.ico"]) {
      expect(isPortalPassThrough(p)).toBe(true);
    }
  });
  it("does not pass through the root or a cycle slug", () => {
    expect(isPortalPassThrough("/")).toBe(false);
    expect(isPortalPassThrough("/fall-2026")).toBe(false);
  });
});

describe("rewriteToApply", () => {
  it("maps root to /apply and a slug under /apply", () => {
    expect(rewriteToApply("/")).toBe("/apply");
    expect(rewriteToApply("/fall-2026")).toBe("/apply/fall-2026");
  });
});

describe("isReservedSlug", () => {
  it("flags reserved words and clears normal slugs", () => {
    expect(isReservedSlug("api")).toBe(true);
    expect(isReservedSlug("LOGIN")).toBe(true);
    expect(isReservedSlug("fall-2026")).toBe(false);
  });
  it("keeps the reserved set aligned with pass-through first segments", () => {
    for (const s of RESERVED_PORTAL_SLUGS) expect(isPortalPassThrough(`/${s}`)).toBe(true);
  });
});

describe("buildPortalUrl", () => {
  it("uses the pretty form when a portal base is set", () => {
    expect(buildPortalUrl("https://apply.havenfreeclinic.org", "https://hub.example.org", "fall-2026"))
      .toBe("https://apply.havenfreeclinic.org/fall-2026");
    expect(buildPortalUrl("https://apply.havenfreeclinic.org/", "https://hub.example.org"))
      .toBe("https://apply.havenfreeclinic.org");
  });
  it("falls back to the /apply-prefixed hub path when no portal base", () => {
    expect(buildPortalUrl(undefined, "https://hub.example.org", "fall-2026"))
      .toBe("https://hub.example.org/apply/fall-2026");
    expect(buildPortalUrl(undefined, "https://hub.example.org/"))
      .toBe("https://hub.example.org/apply");
  });
});

describe("pickPortalEmailBase", () => {
  const portal = "https://apply.havenfreeclinic.org";
  const app = "https://hub.example.org";
  it("returns the portal base only when the request host matches it", () => {
    expect(pickPortalEmailBase("apply.havenfreeclinic.org", portal, app)).toBe(portal);
  });
  it("returns the app base for any other or missing host", () => {
    expect(pickPortalEmailBase("hub.example.org", portal, app)).toBe(app);
    expect(pickPortalEmailBase("evil.com", portal, app)).toBe(app);
    expect(pickPortalEmailBase(null, portal, app)).toBe(app);
    expect(pickPortalEmailBase("apply.havenfreeclinic.org", undefined, app)).toBe(app);
  });
});
