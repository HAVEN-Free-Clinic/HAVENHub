/**
 * Backfill completionDate for HipaaCertificate rows that have none.
 *
 * Dry-run by default; pass --apply to write changes.
 *
 *   npm run backfill:dates:dry
 *   npm run backfill:dates:apply
 *
 * AIRTABLE field for "HIPAA Last Completed Date" (AI text): fldpQ3GY24wqJQ4Md
 * The value arrives as a plain string OR an object { state, value, isStale }.
 * We handle both and return the text string or null.
 */
import { config } from "@/platform/config";
import { AirtableClient } from "@/platform/airtable/client";
import { extractCompletionDate } from "@/platform/compliance/parser";
import { backfillCompletionDates } from "@/platform/compliance/backfill";
import { getObject } from "@/platform/storage";

// ---------------------------------------------------------------------------
// Field ID for "HIPAA Last Completed Date" on the All People table
// ---------------------------------------------------------------------------
const HIPAA_DATE_FIELD_ID = "fldpQ3GY24wqJQ4Md";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the AI-generated date text from an Airtable record's HIPAA date field.
 *
 * The field value may arrive as:
 *   - A plain string: "2025-06-01"
 *   - An AI object:  { state: "generated", value: "2025-06-01", isStale: false }
 *
 * Returns the text string or null if absent / unrecognised shape.
 */
function extractAiText(fieldValue: unknown): string | null {
  if (fieldValue === null || fieldValue === undefined) return null;
  if (typeof fieldValue === "string") return fieldValue.trim() || null;
  if (typeof fieldValue === "object" && !Array.isArray(fieldValue)) {
    const obj = fieldValue as Record<string, unknown>;
    if (typeof obj.value === "string") return obj.value.trim() || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!config.AIRTABLE_PAT) {
    console.error("AIRTABLE_PAT is not set in .env");
    process.exit(1);
  }

  const dryRun = !process.argv.includes("--apply");

  console.log(
    dryRun
      ? "DRY RUN -- no changes will be written."
      : "APPLY MODE -- writing to database.",
  );
  console.log();

  const client = new AirtableClient(config.AIRTABLE_PAT);
  // Use the source-of-truth management base for individual record lookups.
  // The mirror base is write-only and may not have the AI fields.
  const baseId = config.HAVEN_MGMT_BASE_ID;
  const tableId = config.ALL_PEOPLE_TABLE_ID;

  const result = await backfillCompletionDates(
    {
      parse: extractCompletionDate,
      // Read cert bytes through the storage layer (Vercel Blob in prod, disk
      // locally) -- the SAME layer the certificates importer wrote them through.
      // The old code read config.UPLOAD_DIR directly, so in production (bytes in
      // Blob) every read returned null and the PDF-parse strategy was silently
      // skipped for every certificate. (#2)
      readFile: (storedName: string) => getObject(storedName),
      fetchAirtableDate: async (airtableRecordId: string): Promise<string | null> => {
        try {
          const record = await client.getRecord(baseId, tableId, airtableRecordId);
          const fieldValue = record.fields[HIPAA_DATE_FIELD_ID];
          return extractAiText(fieldValue);
        } catch (err) {
          // Log but don't crash the whole run
          console.warn(`  [warn] Airtable fetch failed for ${airtableRecordId}: ${String(err)}`);
          return null;
        }
      },
    },
    { dryRun },
  );

  console.log("=== RESULTS ===");
  console.log(`  PARSED   (from PDF):      ${result.parsed}`);
  console.log(`  AIRTABLE (from AI field): ${result.airtable}`);
  console.log(`  NONE     (unresolvable):  ${result.none.length}`);
  console.log();

  if (result.none.length > 0) {
    console.log("--- NONE list (certId | fileName) ---");
    for (const n of result.none) {
      console.log(`  ${n.certId}  ${n.fileName}`);
    }
    console.log();
  }

  if (dryRun) {
    console.log("Dry run complete. Re-run with --apply to write changes.");
  } else {
    console.log("Backfill applied successfully.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
