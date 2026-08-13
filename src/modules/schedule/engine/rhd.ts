/**
 * RHD (Reproductive Health Department) clinic readiness computation.
 *
 * Ported from the legacy HAVEN scheduler on 2026-06-07.
 * Source: server/rhd.ts (partial port)
 *
 * Ported:
 *   ProcedureStatus, ProcedureKey, PROCEDURE_KEYS, Attending (now ReadinessAttending),
 *   RhdPersonLite (renamed from PersonLite), ClinicInput, ClinicReadiness,
 *   computeClinicReadiness, dedupeById (private)
 *
 * NOT ported (Excel ingestion is dead in this codebase):
 *   parseRhdCell, RhdDept, RhdCell, RhdSheetPersonRow, RhdDayPlan,
 *   RhdImportPlan, buildRhdImportPlan
 *
 * Changes from legacy:
 * - PersonLite renamed to RhdPersonLite to be explicit at the module boundary.
 * - dedupeById kept private (unexported).
 * - No em-dashes in comments.
 */

export type ProcedureStatus = "yes" | "no" | "unknown";

export type ProcedureKey = "iudIn" | "iudOut" | "nexplanon" | "gac" | "emb" | "seesMale";

export const PROCEDURE_KEYS: ProcedureKey[] = [
  "iudIn", "iudOut", "nexplanon", "gac", "emb", "seesMale",
];

/**
 * An attending as the readiness computation needs one: identity plus the six
 * reproductive-health procedure answers, flattened.
 *
 * Named ReadinessAttending, not Attending, so it does not collide with the
 * Prisma model of that name. The two differ on purpose: the model stores
 * qualifications as rows keyed by capability, while this engine is a port that
 * wants a fixed six-key record. buildRhdBlock projects one onto the other.
 */
export type ReadinessAttending = {
  id: string;
  scheduleName: string;
  fullName: string;
  /** Which slot they cover, e.g. "Morning". Absent on a line with one slot. */
  slotLabel?: string;
  procedures: Record<ProcedureKey, ProcedureStatus>;
  notes?: string;
};

/** Minimal person record needed for clinic readiness computation. */
export type RhdPersonLite = {
  id: string;
  email: string;
  licensedRN: boolean;
  spanishVerified: boolean;
};

export type ClinicInput = {
  date: string; // ISO
  /**
   * Everyone covering this date, one per staffed slot, in slot order. Was a
   * single attending; a service line can now split its day into named slots and
   * staff each separately.
   */
  attendings: ReadinessAttending[];
  director: string | null;
  sctsOnShift: RhdPersonLite[];
  jctsOnShift: RhdPersonLite[];
  ccrhOnShift: RhdPersonLite[];
  proceduresBooked: number | null;
  maxProceduresPerClinic: number;
};

export type ClinicReadiness = {
  date: string;
  closed: boolean;
  /** Everyone covering this date, in slot order. Empty when nobody is on. */
  attendings: ReadinessAttending[];
  director: string | null;
  procedures: Record<ProcedureKey, ProcedureStatus>;
  coverage: { sctm: number; jctm: number; rn: number; spanish: number };
  depoOk: boolean;
  proceduresBooked: number | null;
  procedureCapWarning: boolean;
  emails: string[];
};

function unknownProcedures(): Record<ProcedureKey, ProcedureStatus> {
  return {
    iudIn: "unknown", iudOut: "unknown", nexplanon: "unknown",
    gac: "unknown", emb: "unknown", seesMale: "unknown",
  };
}

/**
 * What the DAY can offer, across everyone covering it.
 *
 * "yes" wins: if any attending on the day is qualified, the clinic can book the
 * procedure -- in their slot. Otherwise an explicit "no" from anyone beats
 * silence, because a known gap is more useful than an unanswered question. Only
 * when nobody has answered does the day read "unknown".
 *
 * This union is what makes per-day procedure coverage meaningful once a day can
 * carry two attendings. It deliberately does not say WHICH slot; the panel lists
 * the attendings, and procedures booked is a per-day number anyway.
 */
function mergeProcedures(
  attendings: ReadinessAttending[],
): Record<ProcedureKey, ProcedureStatus> {
  const out = unknownProcedures();
  for (const key of PROCEDURE_KEYS) {
    const values = attendings.map((a) => a.procedures[key]);
    out[key] = values.includes("yes") ? "yes" : values.includes("no") ? "no" : "unknown";
  }
  return out;
}

function dedupeById(people: RhdPersonLite[]): RhdPersonLite[] {
  const seen = new Set<string>();
  const out: RhdPersonLite[] = [];
  for (const p of people) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

export function computeClinicReadiness(input: ClinicInput): ClinicReadiness {
  const all = dedupeById([...input.sctsOnShift, ...input.jctsOnShift, ...input.ccrhOnShift]);
  const closed = input.attendings.length === 0 && all.length === 0;
  const rn = all.filter((p) => p.licensedRN).length;
  const emails = [...new Set(all.map((p) => p.email).filter(Boolean))].sort();

  return {
    date: input.date,
    closed,
    attendings: input.attendings,
    director: input.director,
    procedures: mergeProcedures(input.attendings),
    coverage: {
      sctm: input.sctsOnShift.length,
      jctm: input.jctsOnShift.length,
      rn,
      spanish: all.filter((p) => p.spanishVerified).length,
    },
    depoOk: closed ? true : rn >= 1,
    proceduresBooked: input.proceduresBooked,
    procedureCapWarning:
      !closed && input.proceduresBooked != null && input.proceduresBooked > input.maxProceduresPerClinic,
    emails,
  };
}
