import { describe, it, expect } from "vitest";
import { MODULES } from "@/platform/modules/registry";
import { VOLUNTEER_ENTRY_FALLBACKS } from "./module-entry";

const volunteers = MODULES.find((m) => m.id === "volunteers")!;

describe("every persona admitted to Volunteers has somewhere to land", () => {
  it("covers every additionalAccessPermission the registry admits", () => {
    // This is the invariant that was missing. /volunteers requires
    // volunteers.view, but the module admits four more permissions, and the
    // dashboard tile, the toolbar chip and the breadcrumb all point at
    // /volunteers regardless. A redirect was written for ONE of the four and
    // never extended when the other three were added, so three personas were
    // shown the module and bounced to /no-access on entering it.
    //
    // Asserting against the registry rather than a hardcoded list means adding
    // a fifth admitting permission fails here rather than shipping the same bug
    // a third time.
    const covered = new Set(VOLUNTEER_ENTRY_FALLBACKS.map(([p]) => p));
    for (const permission of volunteers.additionalAccessPermissions ?? []) {
      expect(covered.has(permission), `${permission} admits the module but has no landing page`).toBe(true);
    }
  });

  it("does not route the accessPermission holder away from the root", () => {
    // volunteers.view opens /volunteers itself; a fallback for it would send the
    // page's own audience somewhere else.
    const covered = new Set(VOLUNTEER_ENTRY_FALLBACKS.map(([p]) => p));
    expect(covered.has(volunteers.accessPermission!)).toBe(false);
  });

  it("sends every persona to a page inside the module", () => {
    for (const [, href] of VOLUNTEER_ENTRY_FALLBACKS) {
      expect(href.startsWith("/volunteers/")).toBe(true);
    }
  });

  it("names only permissions the module actually declares", () => {
    // A typo'd permission would silently never match, leaving that persona on
    // the bounce this exists to remove.
    for (const [permission] of VOLUNTEER_ENTRY_FALLBACKS) {
      expect(volunteers.permissions).toContain(permission);
    }
  });
});
