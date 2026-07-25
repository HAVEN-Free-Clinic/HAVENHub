import type { EpicRequestKind } from "@prisma/client";

/**
 * The YNHH service-request flavours the Epic generator can produce. Individual
 * types apply to exactly one person; bulk_* types carry a spreadsheet.
 *
 * This lives at the support module root rather than under services/ so client
 * components can import the mappings without pulling in pdf-lib (which
 * itcm-pdf.ts, the previous home of this union, depends on).
 */
export type EpicRequestType =
  | "new_individual"
  | "mod_individual"
  | "renew_individual"
  | "bulk_new"
  | "bulk_mod"
  | "bulk_renew"
  | "deactivate_individual"
  | "bulk_deactivate";

/**
 * The EpicRequest kind a generated request is tracked as.
 *
 * bulk_mod maps to MODIFY, not RENEW. It used to map to RENEW because the single
 * "Modify / Renew - Bulk" option covered both; bulk_renew now covers renewals, so
 * a modify batch is recorded as a modification.
 */
export function epicKindForRequestType(t: EpicRequestType): EpicRequestKind {
  switch (t) {
    case "new_individual":
    case "bulk_new":
      return "NEW";
    case "mod_individual":
    case "bulk_mod":
      return "MODIFY";
    case "renew_individual":
    case "bulk_renew":
      return "RENEW";
    case "deactivate_individual":
    case "bulk_deactivate":
      return "DEACTIVATE";
  }
}

/** True for the two request types that create a brand new Epic account. These
 *  are the only ones where the person has no Epic ID yet, so the PDF and the
 *  spreadsheet leave the Epic ID column blank. Written as an explicit
 *  comparison, not a substring test: "bulk_renew" contains "new". */
export function isNewAccountRequest(t: EpicRequestType): boolean {
  return t === "new_individual" || t === "bulk_new";
}

/**
 * The request type a Term batch group submits: the individual variant for one
 * person, the bulk variant (with spreadsheet) above one. The generate route
 * rejects a multi-person individual request, so the count must decide this.
 */
export function requestTypeForGroup(
  kind: "NEW" | "MODIFY" | "RENEW",
  count: number
): EpicRequestType {
  if (kind === "NEW") return count === 1 ? "new_individual" : "bulk_new";
  if (kind === "MODIFY") return count === 1 ? "mod_individual" : "bulk_mod";
  return count === 1 ? "renew_individual" : "bulk_renew";
}
