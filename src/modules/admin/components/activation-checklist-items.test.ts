import { describe, expect, it } from "vitest";
import type { ActivationReadiness } from "@/modules/admin/services/term-readiness";
import { activationChecklistItems } from "./activation-checklist-items";

const noon = (iso: string) => new Date(`${iso}T12:00:00Z`);
const FA26 = { id: "fa26", code: "FA26" };

function readiness(overrides: {
  outgoing?: Partial<NonNullable<ActivationReadiness["outgoing"]>>;
  incoming?: Partial<ActivationReadiness["incoming"]>;
} = {}): ActivationReadiness {
  return {
    outgoing: {
      id: "su26", code: "SU26", name: "Summer 2026", endDate: new Date("2026-09-26T00:00:00Z"),
      becomes: "ARCHIVED", remainingClinicDates: [], pendingRequests: 0, notContinuing: 0,
      termScopedRoles: [], ...overrides.outgoing,
    },
    incoming: {
      unpromoted: [], members: 10, heldAtGate: 0, heldBySteps: [], unpublishedDepartments: [],
      ...overrides.incoming,
    },
  };
}

const byKey = (r: ActivationReadiness) =>
  new Map(activationChecklistItems(r, FA26, { hipaa: "HIPAA certificate", training: "Volunteer training" }).map((i) => [i.key, i]));

describe("activationChecklistItems", () => {
  it("warns that an early flip demotes the outgoing term and darkens its remaining clinics", () => {
    const item = byKey(readiness({
      outgoing: { becomes: "PLANNING", remainingClinicDates: [noon("2026-09-12"), noon("2026-09-26")], pendingRequests: 2 },
    })).get("timing");

    expect(item?.tone).toBe("warning");
    expect(item?.text).toContain("moves it back to Planning");
    expect(item?.text).toContain("2 remaining clinic dates (next Sep 12)");
    expect(item?.text).toContain("2 pending shift requests will stay open");
  });

  it("warns about a clinic still to run even after the end date has passed", () => {
    const item = byKey(readiness({ outgoing: { remainingClinicDates: [noon("2026-09-26")] } })).get("timing");
    expect(item?.tone).toBe("warning");
    expect(item?.text).toContain("still has a clinic on Sep 26");
  });

  it("reads as a clean handoff once the outgoing term is over", () => {
    const item = byKey(readiness({ outgoing: { pendingRequests: 1 } })).get("timing");
    expect(item?.tone).toBe("success");
    expect(item?.text).toBe("SU26 has ended and will be archived. Its 1 pending shift request will be cancelled.");
  });

  it("names the people who would fall off every offboarding list", () => {
    const item = byKey(readiness({ outgoing: { notContinuing: 250 } })).get("offboard");
    expect(item?.tone).toBe("warning");
    expect(item?.text).toContain("250 people on the SU26 roster have no place on the FA26 roster");
    expect(item?.link?.href).toBe("/volunteers/offboarding?tab=transition");
  });

  it("names term-scoped role assignments, which stop granting at the flip", () => {
    const item = byKey(readiness({ outgoing: { termScopedRoles: [{ roleName: "Volunteer", count: 1 }] } })).get("roles");
    expect(item?.text).toContain("scoped to SU26");
    expect(item?.text).toContain("Volunteer (1)");
  });

  it("says nothing about roles when none are term-scoped", () => {
    expect(byKey(readiness()).has("roles")).toBe(false);
  });

  it("counts the gate's holds by step, using the term's own step labels", () => {
    const item = byKey(readiness({
      incoming: { members: 240, heldAtGate: 46, heldBySteps: [{ key: "training", count: 40 }, { key: "hipaa", count: 12 }] },
    })).get("gate");
    expect(item?.tone).toBe("warning");
    expect(item?.text).toBe(
      "46 of 240 FA26 members would be held at onboarding as soon as it is active. Missing: Volunteer training (40), HIPAA certificate (12).",
    );
    expect(item?.link?.href).toBe("/volunteers?term=fa26");
  });

  it("lists unpromoted acceptances per cycle, and unpublished drafts", () => {
    const items = byKey(readiness({
      incoming: {
        unpromoted: [{ cycleId: "c1", title: "Volunteer Fall 2026 Recruitment", count: 166 }],
        unpublishedDepartments: ["PCAR", "SRHD"],
      },
    }));
    expect(items.get("unpromoted:c1")?.text).toBe(
      "166 accepted applicants in Volunteer Fall 2026 Recruitment are not on the FA26 roster yet.",
    );
    expect(items.get("drafts")?.text).toContain("not published for PCAR, SRHD");
  });

  it("has no outgoing checks when there is no term to displace", () => {
    const r = readiness();
    const items = activationChecklistItems({ ...r, outgoing: null }, FA26, {});
    expect(items.map((i) => i.key)).toEqual(["gate"]);
  });
});
