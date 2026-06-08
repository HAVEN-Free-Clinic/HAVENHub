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
  return { id, email: `${id}@yale.edu`, licensedRN: !!opts.rn, spanishSpeaking: !!opts.es };
}

const base: ClinicInput = {
  date: "2026-06-13",
  attending,
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

  it("marks every procedure unknown when there is no attending", () => {
    const r = computeClinicReadiness({ ...base, attending: null, sctsOnShift: [person("a")] });
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

  it("treats an empty, attending-less clinic as closed with no warnings", () => {
    const r = computeClinicReadiness({
      ...base, attending: null, director: null,
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
      jctsOnShift: [{ id: "a", email: "a@yale.edu", licensedRN: false, spanishSpeaking: false }],
      ccrhOnShift: [],
    });
    expect(r.emails).toEqual(["a@yale.edu", "b@yale.edu"]);
  });
});
