/**
 * Import a scoring run's AI reviews for one recruitment cycle.
 *
 * A dry run unless --apply. It prints what would change and writes nothing:
 *
 *   npm run ai-reviews:import -- --cycle <cycleId> --file <run.json> --label "FA26 advisory v2"
 *
 * Add --apply to write it. Add --replace as well to delete this cycle's AI
 * reviews that the file no longer lists (a re-run that dropped applicants).
 *
 * The file is a JSON list of rows, or an object keyed by application id; the row
 * shape is documented on parseAiReviewImport. It holds evaluations of named
 * applicants, so keep it out of the repo.
 *
 * Writes AiReview rows only, never CommitteeScore, and the whole file or none of
 * it: an invalid row, an application outside the cycle, or a best-fit
 * department the cycle does not offer stops the apply.
 */

import * as fs from "fs";
import { prisma } from "../src/platform/db";
import { parseAiReviewImport } from "../src/modules/recruitment/engine/ai-review";
import { importAiReviews } from "../src/modules/recruitment/services/ai-review-import";

const USAGE = 'Usage: npm run ai-reviews:import -- --cycle <cycleId> --file <run.json> --label "<run label>" [--apply] [--replace]';

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

async function main(): Promise<number> {
  const cycleId = option("cycle");
  const file = option("file");
  const label = option("label");
  if (!cycleId || !file || !label) {
    console.error(USAGE);
    return 2;
  }

  const parsed = parseAiReviewImport(JSON.parse(fs.readFileSync(file, "utf8")));
  if (parsed.errors.length > 0) {
    console.error(`${parsed.errors.length} invalid row(s); nothing was checked against the database:`);
    for (const e of parsed.errors.slice(0, 50)) console.error(`  ${e}`);
    if (parsed.errors.length > 50) console.error(`  ...and ${parsed.errors.length - 50} more`);
    return 1;
  }

  const apply = has("apply");
  const plan = await importAiReviews({ cycleId, runLabel: label, rows: parsed.rows, apply, replace: has("replace") });
  console.log(`Cycle:      ${plan.cycleTitle}`);
  console.log(`Run label:  ${plan.runLabel}`);
  console.log(`Rows:       ${plan.rows} (${plan.created} new, ${plan.updated} replacing an existing review)`);
  console.log(`Stale:      ${plan.stale} existing review(s) not in this file${plan.deleted ? `, ${plan.deleted} deleted` : has("replace") ? "" : " (kept; --replace deletes them)"}`);
  console.log(`Unreviewed: ${plan.unreviewed} submitted application(s) with no row in this file`);
  if (plan.problems.length > 0) {
    console.error(`\n${plan.problems.length} problem(s); nothing was written:`);
    for (const p of plan.problems.slice(0, 50)) console.error(`  ${p}`);
    if (plan.problems.length > 50) console.error(`  ...and ${plan.problems.length - 50} more`);
    return 1;
  }
  console.log(plan.applied ? "\nApplied." : "\nDry run: nothing written. Re-run with --apply to write it.");
  return 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  });
