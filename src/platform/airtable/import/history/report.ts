import type { ImportReport } from "./load";

const list = (values: string[]): string => (values.length ? values.join(", ") : "none");

/**
 * Renders the dry-run (or post-apply) report as plain text for a human to
 * read before anything is written. Every "needs a human" list prints "none"
 * rather than an empty heading, so a clean run reads as visibly clean.
 */
export function formatReport(report: ImportReport): string {
  const lines: string[] = [];
  lines.push(report.dryRun ? "DRY RUN -- no rows were written" : "APPLIED -- rows were written");
  lines.push("");

  lines.push("Per source:");
  if (report.perSource.length === 0) {
    lines.push("  none");
  } else {
    for (const source of report.perSource) {
      lines.push(`  ${source.code}: ${source.rows} rows`);
      const stages = Object.entries(source.byStage)
        .map(([stage, count]) => `${stage}=${count}`)
        .join(", ");
      const outcomes = Object.entries(source.byOutcome)
        .map(([outcome, count]) => `${outcome}=${count}`)
        .join(", ");
      lines.push(`    stages: ${stages || "none"}`);
      lines.push(`    outcomes: ${outcomes || "none"}`);
    }
  }
  lines.push("");

  lines.push("Identities:");
  lines.push(`  rows considered: ${report.identities.rows}`);
  lines.push(`  resolved to: ${report.identities.resolved}`);
  lines.push(`  spanning multiple cycles: ${report.identities.multiCycle}`);
  lines.push(`  merged into an existing applicant: ${report.identitiesMerged}`);
  lines.push("");

  lines.push("Unmapped departments (needs a human):");
  lines.push(`  ${list(report.unmappedDepartments)}`);
  lines.push("");

  lines.push("Unmapped decisions (needs a human):");
  lines.push(`  ${list(report.unmappedDecisions)}`);
  lines.push("");

  lines.push("Rejected NetIDs (needs a human):");
  if (report.rejectedNetIds.length === 0) {
    lines.push("  none");
  } else {
    for (const rejected of report.rejectedNetIds) {
      lines.push(`  ${rejected.recordId}: ${rejected.value}`);
    }
  }

  return lines.join("\n");
}
