import { describe, expect, it } from "vitest";
import { isMaintenanceExempt } from "./gate";

describe("isMaintenanceExempt", () => {
  it("exempts the maintenance page itself, or the redirect would loop", () => {
    expect(isMaintenanceExempt("/maintenance")).toBe(true);
  });

  it("exempts sign-in, including the magic-link confirm step", () => {
    expect(isMaintenanceExempt("/login")).toBe(true);
    expect(isMaintenanceExempt("/login/verify")).toBe(true);
  });

  it("exempts public credential pages and every /api route", () => {
    expect(isMaintenanceExempt("/credential/abc123")).toBe(true);
    expect(isMaintenanceExempt("/api/cron/email")).toBe(true);
    expect(isMaintenanceExempt("/api/auth/callback/microsoft-entra-id")).toBe(true);
  });

  it("exempts the PostHog reverse proxy, which is a rewrite straight out to posthog.com", () => {
    // Blocking it does not protect anything (it reaches none of our database)
    // and does break analytics on the pages that stay up: /login and
    // /maintenance both boot PostHog from the root layout, and every beacon
    // would come back as the HTML maintenance page.
    expect(isMaintenanceExempt("/ingest/decide")).toBe(true);
    expect(isMaintenanceExempt("/ingest/e")).toBe(true);
    expect(isMaintenanceExempt("/ingest/static/array.js")).toBe(true);
  });

  it("exempts static assets and the Next runtime", () => {
    for (const p of ["/favicon.ico", "/brand/login-building.webp", "/robots.txt", "/_next/static/x"]) {
      expect(isMaintenanceExempt(p), p).toBe(true);
    }
  });

  it("blocks the hub, the applicant portal, and the public on-ramps", () => {
    for (const p of [
      "/",
      "/dashboard",
      "/admin/settings",
      "/apply",
      "/apply/fall-2026",
      "/welcome",
      "/get-started",
      "/onboard/contract",
      "/attributions",
    ]) {
      expect(isMaintenanceExempt(p), p).toBe(false);
    }
  });

  it("matches whole segments, so a lookalike prefix is not exempt", () => {
    expect(isMaintenanceExempt("/loginfoo")).toBe(false);
    expect(isMaintenanceExempt("/apinotreally")).toBe(false);
    expect(isMaintenanceExempt("/credentials-page")).toBe(false);
  });

});
// The matching portal-host property -- that /maintenance is never rewritten onto
// /apply/maintenance -- is asserted in src/proxy.test.ts. It cannot live here:
// the eslint boundary forbids platform code importing a module's routing.
