// One-off: run reconciliation immediately (the worker normally does this nightly).
import { config } from "@/platform/config";
import { AirtableClient } from "@/platform/airtable/client";
import { parseFieldMap } from "@/platform/airtable/mirror-map";
import { reconcilePeople } from "@/platform/airtable/reconcile";

async function main() {
  const client = new AirtableClient(config.AIRTABLE_PAT!);
  const corrected = await reconcilePeople(client, {
    enabled: config.AIRTABLE_MIRROR_ENABLED,
    baseId: config.AIRTABLE_MIRROR_BASE_ID ?? "",
    peopleTableId: config.AIRTABLE_MIRROR_PEOPLE_TABLE_ID ?? "",
    fieldMap: parseFieldMap(config.AIRTABLE_MIRROR_FIELD_MAP),
    hipaaFieldId: config.AIRTABLE_MIRROR_HIPAA_FIELD_ID ?? null,
    statusFieldId: config.AIRTABLE_MIRROR_STATUS_FIELD_ID ?? null,
  });
  console.log(`reconciled: ${corrected} record(s) corrected`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
