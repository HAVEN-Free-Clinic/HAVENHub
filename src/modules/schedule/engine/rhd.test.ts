/**
 * Tests for RHD (Reproductive Health Department) clinic readiness engine.
 *
 * Ported from legacy HAVEN scheduler on 2026-06-07.
 * Source: server/tests/rhd.test.ts - only the computeClinicReadiness cases.
 * Skipped: parseRhdCell and buildRhdImportPlan (Excel ingestion removed).
 */

import { describe, it, expect } from "vitest";
import { computeClinicReadiness, type ClinicInput, type RhdPersonLite } from "./rhd";

const attending = {
  id: "att1",
  scheduleName: "Rivera",
  fullName: "Nina Rivera, MD",
  procedures: {
    iudIn: "yes", iudOut: "yes", nexplanon: "yes",
    gac: "no", emb: "yes", seesMale: "no",
  },
} as const;

function person(id: string, opts: { rn?: boolean; es?: boolean } = {}): RhdPersonLite {
  return { id, email: `${id}@yale.edu`, licensedRN: !!opts.rn, spanishVerified: !!opts.es };
}

const base: ClinicInput = {
  date: "2026-06-13",
  attendings: [attending],
  director: "KM",
  sctsOnShift: [person("a"), person("b", { rn: true })],
  jctsOnShift: [person("c", { es: true })],
  ccrhOnShift: [person("d")],
  proceduresBooked: null,
  maxProceduresPerClinic: 3,
};

describe("computeClinicReadiness", () => {
  it("copies the attending's procedure statuses", () => {
    const r = computeClinicReadiness(base);
    expect(r.procedures.iudIn).toBe("yes");
    expect(r.procedures.gac).toBe("no");
  });

  it("marks every procedure unknown when nobody is covering", () => {
    const r = computeClinicReadiness({ ...base, attendings: [], sctsOnShift: [person("a")] });
    expect(r.procedures.iudIn).toBe("unknown");
    expect(r.procedures.seesMale).toBe("unknown");
    expect(r.closed).toBe(false); // people are on shift
  });

  it("counts coverage across the three departments", () => {
    const r = computeClinicReadiness(base);
    expect(r.coverage.sctm).toBe(2);
    expect(r.coverage.jctm).toBe(1);
    expect(r.coverage.rn).toBe(1);
    expect(r.coverage.spanish).toBe(1);
  });

  it("depoOk only when at least one RN is on shift", () => {
    expect(computeClinicReadiness(base).depoOk).toBe(true);
    const noRn = { ...base, sctsOnShift: [person("a")], ccrhOnShift: [person("d")], jctsOnShift: [] };
    expect(computeClinicReadiness(noRn).depoOk).toBe(false);
  });

  it("warns when booked procedures exceed the cap", () => {
    expect(computeClinicReadiness({ ...base, proceduresBooked: 4 }).procedureCapWarning).toBe(true);
    expect(computeClinicReadiness({ ...base, proceduresBooked: 3 }).procedureCapWarning).toBe(false);
    expect(computeClinicReadiness({ ...base, proceduresBooked: null }).procedureCapWarning).toBe(false);
  });

  // A line can split its day into named slots and staff each separately, so the
  // DAY's procedure coverage is the union: if anyone on is qualified, the clinic
  // can book it in their slot.
  describe("with more than one attending on the day", () => {
    const morning = {
      ...attending,
      id: "am",
      scheduleName: "AM",
      slotLabel: "Morning",
      procedures: { ...attending.procedures, iudIn: "yes", gac: "no", emb: "unknown" },
    } as const;
    const afternoon = {
      ...attending,
      id: "pm",
      scheduleName: "PM",
      slotLabel: "Afternoon",
      procedures: { ...attending.procedures, iudIn: "no", gac: "yes", emb: "unknown" },
    } as const;

    it("takes yes from whichever attending offers it", () => {
      const r = computeClinicReadiness({ ...base, attendings: [morning, afternoon] });
      expect(r.procedures.iudIn).toBe("yes");
      expect(r.procedures.gac).toBe("yes");
    });

    it("prefers a known no over silence, and unknown only when nobody answered", () => {
      const r = computeClinicReadiness({
        ...base,
        attendings: [
          { ...morning, procedures: { ...morning.procedures, iudIn: "no", emb: "unknown" } },
          { ...afternoon, procedures: { ...afternoon.procedures, iudIn: "unknown", emb: "unknown" } },
        ],
      });
      expect(r.procedures.iudIn).toBe("no");
      expect(r.procedures.emb).toBe("unknown");
    });

    it("reports everyone covering, in the order given", () => {
      const r = computeClinicReadiness({ ...base, attendings: [morning, afternoon] });
      expect(r.attendings.map((a) => a.slotLabel)).toEqual(["Morning", "Afternoon"]);
    });
  });

  it("treats an empty, attending-less clinic as closed with no warnings", () => {
    const r = computeClinicReadiness({
      ...base, attendings: [], director: null,
      sctsOnShift: [], jctsOnShift: [], ccrhOnShift: [], proceduresBooked: 9,
    });
    expect(r.closed).toBe(true);
    expect(r.depoOk).toBe(true);
    expect(r.procedureCapWarning).toBe(false);
  });

  it("dedupes and sorts the clinic email list", () => {
    const r = computeClinicReadiness({
      ...base,
      sctsOnShift: [person("b"), person("a")],
      jctsOnShift: [{ id: "a", email: "a@yale.edu", licensedRN: false, spanishVerified: false }],
      ccrhOnShift: [],
    });
    expect(r.emails).toEqual(["a@yale.edu", "b@yale.edu"]);
  });
});
