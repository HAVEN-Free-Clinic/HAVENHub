import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MCP_TOOLS, IDENTITY_ARGUMENT_PATTERN, FORBIDDEN_OUTPUT_PATTERN } from "./index";

describe("MCP tool registry", () => {
  it("has unique tool names", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * The load-bearing test. Identity must arrive only from the verified Intercom
   * contact, so no tool may take a person identifier as an argument the model
   * can fill in. Without this, one tool shipped with a `personId` input would
   * quietly reintroduce LLM-asserted identity and nothing else would catch it.
   */
  it("exposes no tool that accepts a person identifier as an argument", () => {
    for (const tool of MCP_TOOLS) {
      for (const key of Object.keys(tool.inputSchema.shape)) {
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
    const violations = Object.keys(offender.shape).filter((k) => IDENTITY_ARGUMENT_PATTERN.test(k));
    expect(violations).toEqual(["personId"]);
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
