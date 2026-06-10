import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache } from "@/platform/settings/service";
import * as configModule from "@/platform/config";
import { mirrorTarget } from "./mirror-target";

beforeEach(async () => { await resetDb(); _resetSettingsCache(); });

describe("mirrorTarget", () => {
  it("reflects the airtable.mirrorEnabled setting (env default false)", async () => {
    // Ensure the env default is false regardless of .env contents, so the first
    // assertion is deterministic.
    const savedEnabled = configModule.config.AIRTABLE_MIRROR_ENABLED;
    Object.assign(configModule.config, { AIRTABLE_MIRROR_ENABLED: false });
    try {
      _resetSettingsCache();
      expect((await mirrorTarget()).enabled).toBe(false);

      await prisma.setting.create({ data: { key: "airtable.mirrorEnabled", value: true } });
      _resetSettingsCache();
      expect((await mirrorTarget()).enabled).toBe(true);
    } finally {
      Object.assign(configModule.config, { AIRTABLE_MIRROR_ENABLED: savedEnabled });
    }
  });

  it("maps the remaining fields from env config (out of UI scope)", async () => {
    const t = await mirrorTarget();
    expect(t.baseId).toBe(configModule.config.AIRTABLE_MIRROR_BASE_ID ?? "");
    expect(t.peopleTableId).toBe(configModule.config.AIRTABLE_MIRROR_PEOPLE_TABLE_ID ?? "");
    expect(t.hipaaFieldId).toBe(configModule.config.AIRTABLE_MIRROR_HIPAA_FIELD_ID ?? null);
    expect(t.statusFieldId).toBe(configModule.config.AIRTABLE_MIRROR_STATUS_FIELD_ID ?? null);
  });
});
