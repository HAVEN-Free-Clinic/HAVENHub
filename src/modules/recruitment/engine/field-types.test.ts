import { expect, it } from "vitest";
import type { FieldType } from "@prisma/client";
import { FIELD_TYPE_META, fieldTypesByGroup } from "./field-types";

const ALL_TYPES: FieldType[] = [
  "SHORT_TEXT", "LONG_TEXT", "SINGLE_SELECT", "MULTI_SELECT", "CHECKBOX",
  "EMAIL", "PHONE", "NUMBER", "DATE", "FILE", "DEPARTMENT_CHOICE", "SUBCOMMITTEE_RANK",
];

it("has metadata for every FieldType", () => {
  for (const t of ALL_TYPES) {
    const meta = FIELD_TYPE_META[t];
    expect(meta, `missing meta for ${t}`).toBeTruthy();
    expect(meta.label.length).toBeGreaterThan(0);
    expect(meta.icon).toBeTruthy();
  }
});

it("marks only select types as having options", () => {
  expect(FIELD_TYPE_META.SINGLE_SELECT.hasOptions).toBe(true);
  expect(FIELD_TYPE_META.MULTI_SELECT.hasOptions).toBe(true);
  expect(FIELD_TYPE_META.SHORT_TEXT.hasOptions).toBe(false);
  expect(FIELD_TYPE_META.DEPARTMENT_CHOICE.hasOptions).toBe(false);
});

it("marks FILE as a file field", () => {
  expect(FIELD_TYPE_META.FILE.isFile).toBe(true);
  expect(FIELD_TYPE_META.SHORT_TEXT.isFile).toBe(false);
});

it("groups every type exactly once", () => {
  const flat = fieldTypesByGroup().flatMap((g) => g.types);
  expect(new Set(flat).size).toBe(ALL_TYPES.length);
  for (const t of ALL_TYPES) expect(flat).toContain(t);
});

it("exposes SUBCOMMITTEE_RANK in a Subcommittee group", () => {
  expect(FIELD_TYPE_META.SUBCOMMITTEE_RANK).toBeDefined();
  expect(FIELD_TYPE_META.SUBCOMMITTEE_RANK.hasOptions).toBe(false);
  const groups = fieldTypesByGroup();
  const sub = groups.find((g) => g.group === "Subcommittee");
  expect(sub?.types).toContain("SUBCOMMITTEE_RANK");
});
