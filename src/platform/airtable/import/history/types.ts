import type { ApplicantType, HistoricalOutcome, HistoricalStage, Track } from "@prisma/client";

/**
 * The single shape every adapter emits. Five very different Airtable layouts
 * collapse to this type at the boundary so identity resolution, department
 * mapping, loading and reporting are each written once.
 */
export type RawHistoryRow = {
  source: { baseId: string; tableId: string; recordId: string };
  cycle: { code: string; label: string; track: Track; termCode: string | null };
  identity: { firstName: string; lastName: string; email: string | null; netId: string | null };
  applicantType: ApplicantType | null;
  /** Raw Airtable labels. Mapped to Hub codes later, by departments.ts. */
  departmentChoicesRaw: Array<string | null>;
  resultDepartmentRaw: string | null;
  furthestStage: HistoricalStage;
  outcome: HistoricalOutcome;
  submittedAt: Date | null;
  decidedAt: Date | null;
  /** Anything the adapter could not map. Surfaced by the report, never rendered. */
  unmapped: Record<string, unknown> | null;
};

export type RawInterestRow = {
  source: { baseId: string; tableId: string; recordId: string };
  identity: { firstName: string; lastName: string; email: string | null; netId: string | null };
  submittedAt: Date | null;
};
