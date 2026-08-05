import type { Track } from "@prisma/client";

export type HistorySource = {
  code: string;
  label: string;
  track: Track;
  termCode: string | null;
  baseId: string;
  adapter: "volunteer-modern" | "volunteer-fa24" | "volunteer-su26" | "director" | "interest-form";
  /** Adapter-specific table ids. Keys are documented per adapter. */
  tables: Record<string, string>;
};

/**
 * Excluded on purpose, do not re-add without re-checking:
 *   appX9dVg2g9FDJlMl  D-WN26, a clone of D-FA25 carrying the same 89 record ids
 *   appJRUKtCBmg7w3Cp  D-SP25, zero records
 *   app7f51P5guqc8jou  D-SP26, zero records
 *   appIgxGgVKVeSNF72  V-FA25 duplicate, zero records
 *   appXFdgWx7syySXZ1  V-May26, a snapshot copy of the V-SU26 base
 */
export const HISTORY_SOURCES: HistorySource[] = [
  {
    code: "V-FA24", label: "Fall 2024 Volunteer Recruitment", track: "VOLUNTEER", termCode: "FA24",
    baseId: "appSzCKAaB1c1v1f4", adapter: "volunteer-fa24",
    tables: {
      r1New: "tblE35VBMvgvXCepT",
      r1Returning: "tbljJ1ofRVfS9FRy9",
      r1Switch: "tblYgUZqNomvZsIbM",
      r1Ineligible: "tbloxUbXIlwn7RKq1",
      r2All: "tbluCYYTPdZeTt5hU",
      finalDecisions: "tblxJQfR65pPfL4tI",
      nonYale: "tblJ4b5xaCf3ImqEg",
    },
  },
  ...(["SP25", "SU25", "FA25", "SP26"] as const).map((term, i) => ({
    code: `V-${term}`,
    label: { SP25: "Spring 2025", SU25: "Summer 2025", FA25: "Fall 2025", SP26: "Spring 2026" }[term] + " Volunteer Recruitment",
    track: "VOLUNTEER" as Track,
    termCode: term,
    baseId: ["appWSVTqKqiwVyVio", "appBTfqxZSHyf1LBl", "app0DXgMSFvsWW4t8", "appsXFzmnfi5vWzrJ"][i],
    adapter: "volunteer-modern" as const,
    // Table ids are identical across this lineage because each base was
    // duplicated from its predecessor.
    tables: { applications: "tblJPuEMyBq5c2x0W" },
  })),
  {
    // Only the Applicants table is fetched: it carries link fields to
    // Acceptances (tblc15YeGhahLxeA9) and Contracts (tblW5qmRckmvz1QGX), so
    // membership in those is readable without reading them.
    code: "V-SU26", label: "Summer 2026 Volunteer Recruitment", track: "VOLUNTEER", termCode: "SU26",
    baseId: "appOq1yOiA1Lfzq8L", adapter: "volunteer-su26",
    tables: { applicants: "tblV3UrQQvIIZzFTU" },
  },
  ...([
    ["D-FA24", "Fall 2024", "FA24", "appwhZqNU4zCkQ9U2"],
    ["D-SU25", "Summer 2025", "SU25", "app5ma8K8a1qansUu"],
    ["D-FA25", "Fall 2025", "FA25", "appvvlDJLmGfN0340"],
  ] as const).map(([code, name, termCode, baseId]) => ({
    code, label: `${name} Director Recruitment`, track: "DIRECTOR" as Track, termCode,
    baseId, adapter: "director" as const,
    // Applications carries the STAGE (its Interview Details, Decisions and
    // Director Contracts links), but the decision VALUE lives only on Final
    // Decisions: Applications has no decision lookup, verified 2026-08-05.
    // Without this second table every rejection imports as NO_DECISION.
    tables: { applications: "tbluFoybFPBjBAXyk", finalDecisions: "tblfw1kjlBc5fULrY" },
  })),
  {
    // This base has neither a Final Decisions nor a Candidate Evaluations
    // table. The director adapter reads only Applications regardless, deriving
    // everything from its link fields, so no deviation is needed here.
    code: "D-SU26", label: "Summer 2026 Director Recruitment", track: "DIRECTOR", termCode: "SU26",
    baseId: "app6MHzSA1yPej2zX", adapter: "director",
    tables: { applications: "tbluFoybFPBjBAXyk" },
  },
  {
    code: "INTEREST", label: "Interest form", track: "VOLUNTEER", termCode: null,
    baseId: "appyZMpXNJ0rVzOT8", adapter: "interest-form",
    tables: { responses: "tblEacqiHtqKMJphX", responsesOld: "tbl55zvZUFQgcnp04" },
  },
];
