import { describe, it, expect } from "vitest";
import { MODULES } from "@/platform/modules/registry";
import { CLINIC_WIDE_ROSTER_PERMISSIONS, VOLUNTEER_ENTRY_FALLBACKS } from "./module-entry";

const volunteers = MODULES.find((m) => m.id === "volunteers")!;
const fallbackPermissions = new Set(VOLUNTEER_ENTRY_FALLBACKS.map(([p]) => p));
const rosterPermissions = new Set<string>([volunteers.accessPermission!, ...CLINIC_WIDE_ROSTER_PERMISSIONS]);

describe("every persona admitted to Volunteers has somewhere to land", () => {
  it("covers every additionalAccessPermission the registry admits", () => {
    // This is the invariant that was missing. The module admits more
    // permissions than the roster at /volunteers does, and the dashboard tile,
    // the toolbar chip and the breadcrumb all point at /volunteers regardless.
    // A redirect was written for ONE persona and never extended when three more
    // were added, so three personas were shown the module and bounced to
    // /no-access on entering it.
    //
    // Asserting against the registry rather than a hardcoded list means adding
    // an admitting permission fails here rather than shipping the same bug again.
    for (const permission of volunteers.additionalAccessPermissions ?? []) {
      const lands = rosterPermissions.has(permission) || fallbackPermissions.has(permission);
      expect(lands, `${permission} admits the module but has no landing page`).toBe(true);
    }
  });

  it("does not route a roster holder away from the root", () => {
    // volunteers.view opens the roster scoped to the viewer's departments, and
    // the clinic-wide pair opens it for everyone. A fallback for any of them
    // would send the roster's own audience somewhere else. (view_compliance used
    // to be sent to /volunteers/ehs, before the two rosters became one.)
    for (const permission of rosterPermissions) {
      expect(fallbackPermissions.has(permission), `${permission} opens the roster`).toBe(false);
    }
  });

  it("sends every persona to a page inside the module", () => {
    for (const [, href] of VOLUNTEER_ENTRY_FALLBACKS) {
      expect(href.startsWith("/volunteers/")).toBe(true);
    }
  });

  it("names only permissions the module actually declares", () => {
    // A typo'd permission would silently never match, leaving that persona on
    // the bounce this exists to remove.
    for (const permission of [...fallbackPermissions, ...CLINIC_WIDE_ROSTER_PERMISSIONS]) {
      expect(volunteers.permissions).toContain(permission);
    }
  });
});
