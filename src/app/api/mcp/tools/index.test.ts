import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MCP_TOOLS, IDENTITY_ARGUMENT_PATTERN, FORBIDDEN_OUTPUT_PATTERN, collectSchemaKeys } from "./index";

describe("MCP tool registry", () => {
  it("has unique tool names", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * The load-bearing test. Identity must arrive only from the verified Intercom
   * contact, so no tool may take a person identifier as an argument the model
   * can fill in, at any nesting depth. Without this, one tool shipped with a
   * `personId` input -- even nested under an unrelated wrapper key -- would
   * quietly reintroduce LLM-asserted identity and nothing else would catch it.
   *
   * Every tool currently registered has an empty schema, so this loop asserts
   * nothing on its own today; the constructed-schema tests below are what
   * actually exercise collectSchemaKeys ahead of phase 2 registering a tool
   * that takes real input.
   */
  it("exposes no tool that accepts a person identifier as an argument, at any nesting depth", () => {
    for (const tool of MCP_TOOLS) {
      for (const key of collectSchemaKeys(tool.inputSchema)) {
        expect(
          IDENTITY_ARGUMENT_PATTERN.test(key),
          `Tool "${tool.name}" accepts identity-shaped input "${key}". Identity must come from the verified contact, never a tool argument.`
        ).toBe(false);
      }
    }
  });

  it("rejects identity-shaped keys and allows ordinary ones", () => {
    const rejected = ["personId", "person_id", "userId", "netId", "memberEmail", "actorId", "requesterId", "contactId", "identityId"];
    for (const key of rejected) {
      expect(IDENTITY_ARGUMENT_PATTERN.test(key), `${key} should be rejected`).toBe(true);
    }
    const allowed = ["date", "departmentCode", "limit", "includeTags"];
    for (const key of allowed) {
      expect(IDENTITY_ARGUMENT_PATTERN.test(key), `${key} should be allowed`).toBe(false);
    }
  });

  it("guards a tool that violates the rule", () => {
    const offender = z.object({ personId: z.string() });
    const violations = collectSchemaKeys(offender).filter((k) => IDENTITY_ARGUMENT_PATTERN.test(k));
    expect(violations).toEqual(["personId"]);
  });

  it("catches an identity-shaped key nested under an unrelated wrapper key", () => {
    const offender = z.object({ filter: z.object({ personId: z.string() }) });
    const keys = collectSchemaKeys(offender);
    expect(keys).toContain("personId");
    const violations = keys.filter((k) => IDENTITY_ARGUMENT_PATTERN.test(k));
    expect(violations).toEqual(["personId"]);
  });

  it("rejects a z.record schema outright, since no key-name check can bound it", () => {
    const offender = z.object({ filter: z.record(z.string(), z.string()) });
    expect(() => collectSchemaKeys(offender)).toThrow(/z\.record/);
  });

  it("rejects a passthrough object, since it admits unknown keys", () => {
    const offender = z.object({ a: z.string() }).passthrough();
    expect(() => collectSchemaKeys(offender)).toThrow(/unknown keys/);
  });

  it("allows a legitimately nested schema with no identity-shaped keys", () => {
    const innocuous = z.object({ filter: z.object({ date: z.string(), limit: z.number() }) });
    const violations = collectSchemaKeys(innocuous).filter((k) => IDENTITY_ARGUMENT_PATTERN.test(k));
    expect(violations).toEqual([]);
  });

  it("forbids sensitive output fields and allows ordinary ones", () => {
    const forbidden = ["govId", "dateOfBirth", "photoKey", "MemberLoginToken", "passwordHash", "storageKey", "scormBlobKey"];
    for (const key of forbidden) {
      expect(FORBIDDEN_OUTPUT_PATTERN.test(key), `${key} should be forbidden`).toBe(true);
    }
    const allowed = ["departmentName", "clinicDate", "cacheKey"];
    for (const key of allowed) {
      expect(FORBIDDEN_OUTPUT_PATTERN.test(key), `${key} should be allowed`).toBe(false);
    }
  });
});
