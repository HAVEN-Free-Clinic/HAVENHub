// src/platform/gitbook/schema-artifact.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildAdaptiveSchema } from "./catalog";

describe("committed adaptive-schema.json", () => {
  it("matches buildAdaptiveSchema() (regenerate with scripts/gen-gitbook-adaptive-schema.ts)", () => {
    const path = resolve(process.cwd(), "docs/gitbook/adaptive-schema.json");
    const committed = JSON.parse(readFileSync(path, "utf8"));
    expect(committed).toEqual(buildAdaptiveSchema());
  });
});
