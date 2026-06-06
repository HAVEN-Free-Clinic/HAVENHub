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
});
