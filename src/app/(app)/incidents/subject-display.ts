/**
 * Shared display helpers for incident report subject names and aggregate
 * strike status, used by both the "My reports" and "Review queue" tables.
 * Plain module (not "use client") since these are pure string helpers used
 * from server components.
 */

/**
 * Formats a report's linked subject names for a table cell. Empty means the
 * subject was described only in free text, not linked to a Person record.
 */
export function formatSubjectNames(names: string[]): string {
  if (names.length === 0) return "(described in report)";
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2} more`;
}

/**
 * Aggregates per-subject strike decisions into a single label for a report
 * row. Pending takes priority over issued; no label when neither applies.
 */
export function aggregateStrikeLabel(pending: number, issued: number): string {
  if (pending > 0) return "Strike pending";
  if (issued > 0) return "Strike issued";
  return "";
}
