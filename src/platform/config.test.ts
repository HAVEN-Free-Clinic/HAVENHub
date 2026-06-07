import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const base = {
  DATABASE_URL: "postgresql://x:y@localhost:5433/db",
  AUTH_SECRET: "secret",
  NODE_ENV: "development",
};

describe("loadConfig", () => {
  it("accepts a valid development env without Azure vars", () => {
    const config = loadConfig(base);
    expect(config.DATABASE_URL).toBe(base.DATABASE_URL);
  });

  it("fails loudly when DATABASE_URL is missing, naming the variable", () => {
    const { DATABASE_URL: _omitted, ...env } = base;
    expect(() => loadConfig(env)).toThrowError(/DATABASE_URL/);
  });

  it("requires Azure variables in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrowError(
      /AZURE_AD_CLIENT_ID/
    );
  });

  it("accepts production env when Azure variables are present", () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: "production",
      AZURE_AD_CLIENT_ID: "id",
      AZURE_AD_CLIENT_SECRET: "secret",
      AZURE_AD_TENANT_ID: "tenant",
    });
    expect(config.AZURE_AD_TENANT_ID).toBe("tenant");
  });

  it("skips the Azure requirement during next build (NEXT_PHASE)", () => {
    process.env.NEXT_PHASE = "phase-production-build";
    try {
      const config = loadConfig({ ...base, NODE_ENV: "production" });
      expect(config.NODE_ENV).toBe("production");
    } finally {
      delete process.env.NEXT_PHASE;
    }
  });

  it("defaults Airtable base/table ids and leaves the PAT unset", () => {
    const config = loadConfig(base);
    expect(config.HAVEN_MGMT_BASE_ID).toBe("appkxTQ19GmaHgW1O");
    expect(config.AIRTABLE_PAT).toBeUndefined();
    expect(config.AIRTABLE_MIRROR_ENABLED).toBe(false);
  });

  it("requires mirror base/table and PAT when the mirror is enabled", () => {
    expect(() =>
      loadConfig({ ...base, AIRTABLE_MIRROR_ENABLED: "true" })
    ).toThrowError(/AIRTABLE_MIRROR_BASE_ID/);
  });

  it("accepts a fully-configured enabled mirror", () => {
    const config = loadConfig({
      ...base,
      AIRTABLE_MIRROR_ENABLED: "true",
      AIRTABLE_PAT: "pat-x",
      AIRTABLE_MIRROR_BASE_ID: "appSandbox1234567",
      AIRTABLE_MIRROR_PEOPLE_TABLE_ID: "tblSandbox1234567",
    });
    expect(config.AIRTABLE_MIRROR_ENABLED).toBe(true);
  });

  it("rejects a bad AIRTABLE_MIRROR_FIELD_MAP when mirror is enabled", () => {
    expect(() =>
      loadConfig({
        ...base,
        AIRTABLE_MIRROR_ENABLED: "true",
        AIRTABLE_PAT: "pat-x",
        AIRTABLE_MIRROR_BASE_ID: "appSandbox1234567",
        AIRTABLE_MIRROR_PEOPLE_TABLE_ID: "tblSandbox1234567",
        AIRTABLE_MIRROR_FIELD_MAP: "not-valid-json",
      })
    ).toThrowError(/AIRTABLE_MIRROR_FIELD_MAP/);
  });

  it("rejects an AIRTABLE_MIRROR_FIELD_MAP missing required keys when mirror is enabled", () => {
    expect(() =>
      loadConfig({
        ...base,
        AIRTABLE_MIRROR_ENABLED: "true",
        AIRTABLE_PAT: "pat-x",
        AIRTABLE_MIRROR_BASE_ID: "appSandbox1234567",
        AIRTABLE_MIRROR_PEOPLE_TABLE_ID: "tblSandbox1234567",
        AIRTABLE_MIRROR_FIELD_MAP: JSON.stringify({ name: "fldA", netId: "fldB" }),
      })
    ).toThrowError(/AIRTABLE_MIRROR_FIELD_MAP/);
  });

  it("accepts a fully-configured enabled mirror with a valid field map", () => {
    const fieldMap = {
      name: "fldnyPNurTfUTCI3M",
      netId: "fldzDXBuegWh43qBe",
      contactEmail: "flddaZKIRSx3xoss3",
      phone: "fldKV9uyerHHBr9VB",
      epicId: "fldYAk27EVKbK9GZn",
      yaleAffiliation: "fldcqbmdOvL1ZwXgH",
      gradYear: "fldVjHtbPzhGXeH75",
    };
    const config = loadConfig({
      ...base,
      AIRTABLE_MIRROR_ENABLED: "true",
      AIRTABLE_PAT: "pat-x",
      AIRTABLE_MIRROR_BASE_ID: "appSandbox1234567",
      AIRTABLE_MIRROR_PEOPLE_TABLE_ID: "tblSandbox1234567",
      AIRTABLE_MIRROR_FIELD_MAP: JSON.stringify(fieldMap),
    });
    expect(config.AIRTABLE_MIRROR_ENABLED).toBe(true);
    expect(config.AIRTABLE_MIRROR_FIELD_MAP).toBe(JSON.stringify(fieldMap));
  });
});
