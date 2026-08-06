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

  it("defaults APP_BASE_URL to localhost:3000", () => {
    const config = loadConfig(base);
    expect(config.APP_BASE_URL).toBe("http://localhost:3000");
  });

  it("accepts a valid APP_BASE_URL", () => {
    const config = loadConfig({ ...base, APP_BASE_URL: "https://hub.havenfreeclinic.org" });
    expect(config.APP_BASE_URL).toBe("https://hub.havenfreeclinic.org");
  });

  it("rejects a scheme-less APP_BASE_URL at boot, naming the variable (#67)", () => {
    // Without .url() this passed z.string() and only blew up later at render, in
    // new URL() on the universal metadata path -- 500ing every route with no way
    // to reach /admin/settings to fix it. It must fail loudly at boot instead.
    expect(() => loadConfig({ ...base, APP_BASE_URL: "staging.havenfreeclinic.org" })).toThrowError(
      /APP_BASE_URL/
    );
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
  });

  it("defaults SU26_SCHEDULE_TABLE_ID to the known table id", () => {
    const config = loadConfig(base);
    expect(config.SU26_SCHEDULE_TABLE_ID).toBe("tblqJlM85Em0AA767");
  });

  // --- Upload config ---

  it("defaults UPLOAD_DIR to ./uploads and MAX_UPLOAD_MB to 4 (server-action body cap)", () => {
    const config = loadConfig(base);
    expect(config.UPLOAD_DIR).toBe("./uploads");
    expect(config.MAX_UPLOAD_MB).toBe(4);
  });

  it("accepts a custom UPLOAD_DIR", () => {
    const config = loadConfig({ ...base, UPLOAD_DIR: "/var/data/uploads" });
    expect(config.UPLOAD_DIR).toBe("/var/data/uploads");
  });

  it("transforms MAX_UPLOAD_MB string to number", () => {
    const config = loadConfig({ ...base, MAX_UPLOAD_MB: "25" });
    expect(config.MAX_UPLOAD_MB).toBe(25);
  });

  it("rejects MAX_UPLOAD_MB 'abc' naming the variable", () => {
    expect(() => loadConfig({ ...base, MAX_UPLOAD_MB: "abc" })).toThrowError(
      /MAX_UPLOAD_MB/
    );
  });

  it("rejects MAX_UPLOAD_MB '0' naming the variable", () => {
    expect(() => loadConfig({ ...base, MAX_UPLOAD_MB: "0" })).toThrowError(
      /MAX_UPLOAD_MB/
    );
  });

  it("rejects MAX_UPLOAD_MB negative value naming the variable", () => {
    expect(() => loadConfig({ ...base, MAX_UPLOAD_MB: "-5" })).toThrowError(
      /MAX_UPLOAD_MB/
    );
  });

  // --- Compliance reminder cadence config ---

  it("defaults COMPLIANCE_REMINDER_INTERVAL_DAYS to 7", () => {
    const config = loadConfig(base);
    expect(config.COMPLIANCE_REMINDER_INTERVAL_DAYS).toBe(7);
  });

  it("rejects COMPLIANCE_REMINDER_INTERVAL_DAYS 'abc' naming the variable", () => {
    expect(() =>
      loadConfig({ ...base, COMPLIANCE_REMINDER_INTERVAL_DAYS: "abc" })
    ).toThrowError(/COMPLIANCE_REMINDER_INTERVAL_DAYS/);
  });

  it("rejects COMPLIANCE_REMINDER_INTERVAL_DAYS '0' naming the variable", () => {
    expect(() =>
      loadConfig({ ...base, COMPLIANCE_REMINDER_INTERVAL_DAYS: "0" })
    ).toThrowError(/COMPLIANCE_REMINDER_INTERVAL_DAYS/);
  });

  it("rejects COMPLIANCE_REMINDER_INTERVAL_DAYS '-1' naming the variable", () => {
    expect(() =>
      loadConfig({ ...base, COMPLIANCE_REMINDER_INTERVAL_DAYS: "-1" })
    ).toThrowError(/COMPLIANCE_REMINDER_INTERVAL_DAYS/);
  });

  // --- RHD table IDs ---

  it("defaults RHD_ATTENDINGS_TABLE_ID to tblxDJehirZSLFJna", () => {
    const config = loadConfig(base);
    expect(config.RHD_ATTENDINGS_TABLE_ID).toBe("tblxDJehirZSLFJna");
  });

  it("defaults RHD_CLINICS_TABLE_ID to tbl0HrOcMHUQL0a6C", () => {
    const config = loadConfig(base);
    expect(config.RHD_CLINICS_TABLE_ID).toBe("tbl0HrOcMHUQL0a6C");
  });

  it("accepts custom RHD_ATTENDINGS_TABLE_ID", () => {
    const config = loadConfig({ ...base, RHD_ATTENDINGS_TABLE_ID: "tblCustomAttend" });
    expect(config.RHD_ATTENDINGS_TABLE_ID).toBe("tblCustomAttend");
  });

  it("accepts custom RHD_CLINICS_TABLE_ID", () => {
    const config = loadConfig({ ...base, RHD_CLINICS_TABLE_ID: "tblCustomClinics" });
    expect(config.RHD_CLINICS_TABLE_ID).toBe("tblCustomClinics");
  });

  // --- RHD max procedures config ---

  it("defaults RHD_MAX_PROCEDURES to 3", () => {
    const config = loadConfig(base);
    expect(config.RHD_MAX_PROCEDURES).toBe(3);
  });

  it("rejects RHD_MAX_PROCEDURES 'abc' naming the variable", () => {
    expect(() =>
      loadConfig({ ...base, RHD_MAX_PROCEDURES: "abc" })
    ).toThrowError(/RHD_MAX_PROCEDURES/);
  });

  it("rejects RHD_MAX_PROCEDURES '0' naming the variable", () => {
    expect(() =>
      loadConfig({ ...base, RHD_MAX_PROCEDURES: "0" })
    ).toThrowError(/RHD_MAX_PROCEDURES/);
  });

  it("rejects RHD_MAX_PROCEDURES negative value naming the variable", () => {
    expect(() =>
      loadConfig({ ...base, RHD_MAX_PROCEDURES: "-5" })
    ).toThrowError(/RHD_MAX_PROCEDURES/);
  });

  // --- Email transport config ---

  it("defaults EMAIL_TRANSPORT to log with no vars set", () => {
    const config = loadConfig(base);
    expect(config.EMAIL_TRANSPORT).toBe("log");
  });

  it("defaults GRAPH_OAUTH_REDIRECT_URI to the localhost callback", () => {
    const config = loadConfig(base);
    expect(config.GRAPH_OAUTH_REDIRECT_URI).toBe(
      "http://localhost:3000/admin/email/oauth/callback"
    );
  });

  it("rejects graph mode without OAuth vars, naming each missing key", () => {
    expect(() =>
      loadConfig({ ...base, EMAIL_TRANSPORT: "graph" })
    ).toThrowError(/GRAPH_OAUTH_TENANT_ID/);
    expect(() =>
      loadConfig({ ...base, EMAIL_TRANSPORT: "graph" })
    ).toThrowError(/GRAPH_OAUTH_CLIENT_ID/);
    expect(() =>
      loadConfig({ ...base, EMAIL_TRANSPORT: "graph" })
    ).toThrowError(/GRAPH_OAUTH_CLIENT_SECRET/);
    expect(() =>
      loadConfig({ ...base, EMAIL_TRANSPORT: "graph" })
    ).toThrowError(/EMAIL_SENDER/);
  });

  it("accepts graph mode when all four OAuth/sender vars are present", () => {
    const config = loadConfig({
      ...base,
      EMAIL_TRANSPORT: "graph",
      GRAPH_OAUTH_TENANT_ID: "tenant-id",
      GRAPH_OAUTH_CLIENT_ID: "client-id",
      GRAPH_OAUTH_CLIENT_SECRET: "client-secret",
      EMAIL_SENDER: "noreply@example.com",
    });
    expect(config.EMAIL_TRANSPORT).toBe("graph");
    expect(config.GRAPH_OAUTH_TENANT_ID).toBe("tenant-id");
    expect(config.EMAIL_SENDER).toBe("noreply@example.com");
  });

  // --- Teams clinic channel config ---

  it("exposes TEAMS_CLINIC_GROUP_ID when provided", () => {
    const config = loadConfig({
      ...base,
      TEAMS_CLINIC_GROUP_ID: "4796e633-27e4-4053-8631-d3b4fe64ebe6",
    });
    expect(config.TEAMS_CLINIC_GROUP_ID).toBe(
      "4796e633-27e4-4053-8631-d3b4fe64ebe6"
    );
  });

  it("leaves TEAMS_CLINIC_GROUP_ID undefined when absent", () => {
    const config = loadConfig(base);
    expect(config.TEAMS_CLINIC_GROUP_ID).toBeUndefined();
  });

  // --- Portal base URL (custom application subdomain) ---

  it("leaves PORTAL_BASE_URL undefined when absent", () => {
    const config = loadConfig(base);
    expect(config.PORTAL_BASE_URL).toBeUndefined();
  });

  it("treats an empty PORTAL_BASE_URL as unset (does not crash boot)", () => {
    const config = loadConfig({ ...base, PORTAL_BASE_URL: "" });
    expect(config.PORTAL_BASE_URL).toBeUndefined();
  });

  it("accepts a valid PORTAL_BASE_URL", () => {
    const config = loadConfig({ ...base, PORTAL_BASE_URL: "https://apply.havenfreeclinic.org" });
    expect(config.PORTAL_BASE_URL).toBe("https://apply.havenfreeclinic.org");
  });

  it("rejects a non-empty PORTAL_BASE_URL that is not a URL, naming the variable", () => {
    expect(() => loadConfig({ ...base, PORTAL_BASE_URL: "not-a-url" })).toThrowError(/PORTAL_BASE_URL/);
  });

  // --- Environment banner label (non-production deploy notice) ---

  it("leaves ENV_BANNER_LABEL undefined when absent", () => {
    const config = loadConfig(base);
    expect(config.ENV_BANNER_LABEL).toBeUndefined();
  });

  it("treats an empty ENV_BANNER_LABEL as unset (no banner)", () => {
    const config = loadConfig({ ...base, ENV_BANNER_LABEL: "" });
    expect(config.ENV_BANNER_LABEL).toBeUndefined();
  });

  it("exposes ENV_BANNER_LABEL when provided", () => {
    const config = loadConfig({ ...base, ENV_BANNER_LABEL: "Staging" });
    expect(config.ENV_BANNER_LABEL).toBe("Staging");
  });

  // --- R2 storage config ---

  const r2 = {
    R2_ACCOUNT_ID: "acct123",
    R2_ACCESS_KEY_ID: "akid",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "havenhub-uploads",
  };

  it("accepts an env with no R2 variables at all (local disk storage)", () => {
    const config = loadConfig(base);
    expect(config.R2_BUCKET).toBeUndefined();
  });

  it("accepts a complete R2 configuration", () => {
    const config = loadConfig({ ...base, ...r2 });
    expect(config.R2_BUCKET).toBe("havenhub-uploads");
    expect(config.R2_ACCOUNT_ID).toBe("acct123");
  });

  it("rejects a partial R2 configuration, naming the missing variable", () => {
    // A partial config silently falls back to local disk. On Vercel the function
    // filesystem is ephemeral, so every upload would vanish on the next deploy
    // with no error. It has to fail at boot instead.
    const { R2_SECRET_ACCESS_KEY: _omitted, ...partial } = r2;
    expect(() => loadConfig({ ...base, ...partial })).toThrowError(
      /R2_SECRET_ACCESS_KEY/
    );
  });

  it("rejects a lone R2_ACCOUNT_ID rather than silently using local disk", () => {
    expect(() => loadConfig({ ...base, R2_ACCOUNT_ID: "acct123" })).toThrowError(
      /R2_BUCKET/
    );
  });

  // --- Blob fallback token (R2 migration rollback) ---

  it("accepts a Blob token alongside a complete R2 config (migration fallback)", () => {
    const config = loadConfig({ ...base, ...r2, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x" });
    expect(config.BLOB_READ_WRITE_TOKEN).toBe("vercel_blob_rw_x");
  });

  it("accepts a Blob token with no R2 config (the rolled-back state)", () => {
    const config = loadConfig({ ...base, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x" });
    expect(config.BLOB_READ_WRITE_TOKEN).toBe("vercel_blob_rw_x");
    expect(config.R2_BUCKET).toBeUndefined();
  });
});
