import { config } from "@/platform/config";
import { getSetting } from "@/platform/settings/service";
import { parseFieldMap } from "./mirror-map";
import type { MirrorTarget } from "./mirror";

/**
 * Build the Airtable mirror target. `enabled` comes from admin settings
 * (DB override -> env default); the base/table/field-map identifiers stay in
 * env (out of UI scope). Replaces the duplicated copies in cron.ts and the worker.
 */
export async function mirrorTarget(): Promise<MirrorTarget> {
  return {
    enabled: await getSetting<boolean>("airtable.mirrorEnabled"),
    baseId: config.AIRTABLE_MIRROR_BASE_ID ?? "",
    peopleTableId: config.AIRTABLE_MIRROR_PEOPLE_TABLE_ID ?? "",
    fieldMap: parseFieldMap(config.AIRTABLE_MIRROR_FIELD_MAP),
    hipaaFieldId: config.AIRTABLE_MIRROR_HIPAA_FIELD_ID ?? null,
    statusFieldId: config.AIRTABLE_MIRROR_STATUS_FIELD_ID ?? null,
  };
}
