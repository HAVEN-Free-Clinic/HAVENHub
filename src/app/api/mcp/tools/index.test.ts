import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  MCP_TOOLS,
  IDENTITY_ARGUMENT_PATTERN,
  FORBIDDEN_OUTPUT_PATTERN,
  collectSchemaKeys,
  assertSafeToolOutput,
} from "./index";

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

  /**
   * These six cases are the actual point of item 1: before this fix, a
   * personId hidden inside any of ZodUnion, ZodDiscriminatedUnion,
   * ZodIntersection, ZodLazy, ZodTuple, or a refined/piped wrapper fell
   * through collectSchemaKeys' final `return []` with no error at all --
   * worse than the z.record case above, which at least throws loudly.
   */
  describe("wrapper and composite schema types", () => {
    it("catches a personId hidden inside a union", () => {
      const offender = z.object({
        choice: z.union([z.object({ a: z.string() }), z.object({ personId: z.string() })]),
      });
      expect(collectSchemaKeys(offender)).toContain("personId");
    });

    it("catches a personId hidden inside a discriminated union", () => {
      const offender = z.object({
        query: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("byDate"), date: z.string() }),
          z.object({ kind: z.literal("byPerson"), personId: z.string() }),
        ]),
      });
      expect(collectSchemaKeys(offender)).toContain("personId");
    });

    it("catches a personId hidden inside an intersection", () => {
      const offender = z.object({
        merged: z.intersection(z.object({ a: z.string() }), z.object({ personId: z.string() })),
      });
      expect(collectSchemaKeys(offender)).toContain("personId");
    });

    it("catches a personId hidden inside a lazy schema", () => {
      const offender = z.object({
        nested: z.lazy(() => z.object({ personId: z.string() })),
      });
      expect(collectSchemaKeys(offender)).toContain("personId");
    });

    it("catches a personId hidden inside a tuple", () => {
      const offender = z.object({
        pair: z.tuple([z.string(), z.object({ personId: z.string() })]),
      });
      expect(collectSchemaKeys(offender)).toContain("personId");
    });

    it("catches a personId hidden inside a refined/effects-wrapped object", () => {
      // .transform() is what actually wraps the schema in zod v4 (v3's
      // ZodEffects no longer exists); .refine() attaches a check in place and
      // was already handled before this fix, so it is not the interesting case.
      const offender = z.object({
        payload: z.object({ personId: z.string() }).transform((v) => v.personId),
      });
      expect(collectSchemaKeys(offender)).toContain("personId");
    });

    it("still passes legitimately nested unions, intersections, and tuples with no identity-shaped keys", () => {
      const innocuous = z.object({
        choice: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
        merged: z.intersection(z.object({ c: z.string() }), z.object({ d: z.boolean() })),
        pair: z.tuple([z.string(), z.object({ e: z.number() })]),
      });
      const violations = collectSchemaKeys(innocuous).filter((k) => IDENTITY_ARGUMENT_PATTERN.test(k));
      expect(violations).toEqual([]);
    });

    it("throws on an unrecognised or opaque schema type instead of silently returning no keys", () => {
      // z.map, like z.record, admits arbitrary keys the guard cannot enumerate
      // -- and unlike z.record, nothing in collectSchemaKeys names it
      // specifically, so this exercises the generic "unrecognised type" throw.
      const offender = z.object({ lookup: z.map(z.string(), z.object({ personId: z.string() })) });
      expect(() => collectSchemaKeys(offender)).toThrow(/does not recognise/);
    });
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

  /**
   * FORBIDDEN_OUTPUT_PATTERN, above, only matches field NAMES and has no call
   * sites -- it could never catch a govId or date of birth once a tool
   * formats it into a sentence, since the field name is gone by then. This is
   * the value-level control that actually gets wired into every tool's
   * output (see route.ts).
   */
  describe("assertSafeToolOutput", () => {
    it("blocks a bare 9-digit SSN-shaped value", () => {
      expect(() => assertSafeToolOutput("Your SSN on file is 123456789.")).toThrow();
    });

    it("blocks a dashed NNN-NN-NNNN SSN-shaped value", () => {
      expect(() => assertSafeToolOutput("Your SSN on file is 123-45-6789.")).toThrow();
    });

    it("blocks an ISO date-of-birth-shaped value", () => {
      expect(() => assertSafeToolOutput("Date of birth on file: 1998-04-12.")).toThrow();
    });

    it("does not block a normal answer with a formatted clinic date and a ticket number", () => {
      expect(() =>
        assertSafeToolOutput("Your next shift is on Sep 12, 2026 with Nursing. Ticket #482 is closed.")
      ).not.toThrow();
    });

    it("does not block plain prose with no digits at all", () => {
      expect(() => assertSafeToolOutput("You have no upcoming shifts scheduled.")).not.toThrow();
    });

    /**
     * FORBIDDEN_OUTPUT_PATTERN (field NAMES) had no runtime call site before
     * this test existed -- it was asserted only against hand-built strings in
     * the "forbids sensitive output fields" test above, never wired into the
     * function that actually gates tool output. An accidental
     * `JSON.stringify(person)` is exactly the shape it exists to catch, and it
     * is also the shape DOB_VALUE_PATTERN misses: a serialized Prisma DateTime
     * ("1998-04-12T00:00:00.000Z") runs straight into a `T`, so there is no
     * `\b` word boundary for that pattern to match on.
     */
    it("blocks a serialized object carrying dateOfBirth and photoKey, which the value patterns alone miss", () => {
      const dump = JSON.stringify({
        name: "Jane",
        dateOfBirth: "1998-04-12T00:00:00.000Z",
        photoKey: "people/abc.jpg",
      });
      expect(() => assertSafeToolOutput(dump)).toThrow();
    });
  });
});
