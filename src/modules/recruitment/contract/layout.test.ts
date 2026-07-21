import { describe, it, expect } from "vitest";
import { parseContractLayout, ContractLayoutError } from "./layout";
import { parseFieldCondition, type FieldCondition } from "@/modules/recruitment/engine/field-visibility";

describe("parseContractLayout", () => {
  it("accepts a minimal valid layout", () => {
    const layout = parseContractLayout({
      blocks: [
        { kind: "system_field", systemKey: "name" },
        { kind: "agreement", id: "a1", title: "Agreement", body: "", signatureLabel: "type your name" },
        { kind: "custom_question", key: "tshirt", label: "T-shirt size", type: "SHORT_TEXT", required: false },
      ],
    });
    expect(layout.blocks).toHaveLength(3);
  });

  it("rejects an unknown system key", () => {
    expect(() => parseContractLayout({ blocks: [{ kind: "system_field", systemKey: "nope" }] }))
      .toThrow(ContractLayoutError);
  });

  it("rejects duplicate custom-question keys", () => {
    expect(() => parseContractLayout({ blocks: [
      { kind: "custom_question", key: "q", label: "A", type: "SHORT_TEXT", required: false },
      { kind: "custom_question", key: "q", label: "B", type: "SHORT_TEXT", required: false },
    ] })).toThrow(ContractLayoutError);
  });

  it("rejects a custom-question key that collides with a system key", () => {
    expect(() => parseContractLayout({ blocks: [
      { kind: "custom_question", key: "email", label: "Email", type: "EMAIL", required: true },
    ] })).toThrow(ContractLayoutError);
  });

  it("rejects duplicate agreement ids", () => {
    expect(() => parseContractLayout({ blocks: [
      { kind: "agreement", id: "a1", title: "A", body: "", signatureLabel: "sign" },
      { kind: "agreement", id: "a1", title: "B", body: "", signatureLabel: "sign" },
    ] })).toThrow(ContractLayoutError);
  });
});

describe("section blocks and conditions", () => {
  it("parses a section block", () => {
    const layout = parseContractLayout({
      blocks: [{ kind: "section", id: "demographics", title: "Demographic Information", body: "**Please** complete." }],
    });
    expect(layout.blocks[0]).toEqual({
      kind: "section", id: "demographics", title: "Demographic Information", body: "**Please** complete.",
    });
  });

  it("parses visibleWhen on any block kind", () => {
    const layout = parseContractLayout({
      blocks: [{
        kind: "agreement", id: "bvhd", title: "BVHD", body: "", signatureLabel: "sign",
        confirmKind: "checkbox",
        visibleWhen: { field: "department", op: "is", value: "BVHD" },
      }],
    });
    const b = layout.blocks[0];
    expect(b.kind).toBe("agreement");
    expect(b.visibleWhen).toEqual({ field: "department", op: "is", value: "BVHD" });
  });

  it("rejects duplicate section ids", () => {
    expect(() => parseContractLayout({
      blocks: [
        { kind: "section", id: "s", title: "A", body: "" },
        { kind: "section", id: "s", title: "B", body: "" },
      ],
    })).toThrow(ContractLayoutError);
  });

  it("rejects a section id colliding with an agreement id", () => {
    expect(() => parseContractLayout({
      blocks: [
        { kind: "section", id: "x", title: "A", body: "" },
        { kind: "agreement", id: "x", title: "B", body: "", signatureLabel: "sign" },
      ],
    })).toThrow(ContractLayoutError);
  });

  it("still parses a layout with none of the new properties", () => {
    const layout = parseContractLayout({
      blocks: [{ kind: "agreement", id: "a", title: "A", body: "", signatureLabel: "sign" }],
    });
    expect(layout.blocks[0]).not.toHaveProperty("confirmKind");
  });
});

describe("visibleWhen operators round-trip through parseContractLayout", () => {
  const cases: { name: string; condition: FieldCondition }[] = [
    { name: "isAnswered", condition: { field: "department", op: "isAnswered" } },
    { name: "is", condition: { field: "department", op: "is", value: "BVHD" } },
    { name: "isNot", condition: { field: "department", op: "isNot", value: "BVHD" } },
    { name: "isAnyOf", condition: { field: "department", op: "isAnyOf", value: ["BVHD", "HFC"] } },
  ];

  it.each(cases)("round-trips the $name operator", ({ condition }) => {
    const layout = parseContractLayout({
      blocks: [
        { kind: "agreement", id: "a1", title: "A", body: "", signatureLabel: "sign", visibleWhen: condition },
      ],
    });
    expect(layout.blocks[0].visibleWhen).toEqual(condition);
  });
});

describe("visibleWhen parses on each block kind", () => {
  const condition: FieldCondition = { field: "department", op: "is", value: "BVHD" };

  it("parses visibleWhen on a system_field block", () => {
    const layout = parseContractLayout({
      blocks: [{ kind: "system_field", systemKey: "name", visibleWhen: condition }],
    });
    expect(layout.blocks[0].visibleWhen).toEqual(condition);
  });

  it("parses visibleWhen on an agreement block", () => {
    const layout = parseContractLayout({
      blocks: [
        { kind: "agreement", id: "a1", title: "A", body: "", signatureLabel: "sign", visibleWhen: condition },
      ],
    });
    expect(layout.blocks[0].visibleWhen).toEqual(condition);
  });

  it("parses visibleWhen on a custom_question block", () => {
    const layout = parseContractLayout({
      blocks: [{
        kind: "custom_question", key: "tshirt", label: "T-shirt size", type: "SHORT_TEXT",
        required: false, visibleWhen: condition,
      }],
    });
    expect(layout.blocks[0].visibleWhen).toEqual(condition);
  });

  it("parses visibleWhen on a section block", () => {
    const layout = parseContractLayout({
      blocks: [{ kind: "section", id: "s1", title: "Section", body: "", visibleWhen: condition }],
    });
    expect(layout.blocks[0].visibleWhen).toEqual(condition);
  });
});

describe("rejects malformed visibleWhen conditions", () => {
  it("rejects an is operator with no value", () => {
    expect(() => parseContractLayout({
      blocks: [{
        kind: "agreement", id: "a1", title: "A", body: "", signatureLabel: "sign",
        visibleWhen: { field: "department", op: "is" },
      }],
    })).toThrow(ContractLayoutError);
  });

  it("rejects an isAnyOf operator with a string value instead of an array", () => {
    expect(() => parseContractLayout({
      blocks: [{
        kind: "agreement", id: "a1", title: "A", body: "", signatureLabel: "sign",
        visibleWhen: { field: "department", op: "isAnyOf", value: "BVHD" },
      }],
    })).toThrow(ContractLayoutError);
  });

  it("rejects an unknown operator", () => {
    expect(() => parseContractLayout({
      blocks: [{
        kind: "agreement", id: "a1", title: "A", body: "", signatureLabel: "sign",
        visibleWhen: { field: "department", op: "startsWith", value: "B" },
      }],
    })).toThrow(ContractLayoutError);
  });

  it("rejects an empty field", () => {
    expect(() => parseContractLayout({
      blocks: [{
        kind: "agreement", id: "a1", title: "A", body: "", signatureLabel: "sign",
        visibleWhen: { field: "", op: "isAnswered" },
      }],
    })).toThrow(ContractLayoutError);
  });
});

// Every condition shape that conditionSchema (save time, above) accepts. This
// table is shared by the parity test below so that adding a new accepted
// condition shape here automatically extends coverage on both sides.
const validConditions: FieldCondition[] = [
  { field: "department", op: "isAnswered" },
  { field: "department", op: "is", value: "BVHD" },
  { field: "department", op: "isNot", value: "BVHD" },
  { field: "department", op: "isAnyOf", value: ["BVHD", "HFC"] },
];

// This test exists to catch drift between the save-time schema
// (conditionSchema in layout.ts) and the render-time parser
// (parseFieldCondition in field-visibility.ts). They are two separate
// implementations of the same condition shape. The failure this guards
// against: a layout saves successfully because conditionSchema accepted its
// visibleWhen, but parseFieldCondition can no longer parse that same shape at
// render time, so the block silently shows or hides in a way nobody intended,
// including contract blocks that people legally sign.
describe("conditionSchema and parseFieldCondition parity", () => {
  it.each(validConditions)("parseFieldCondition accepts what conditionSchema accepts: %o", (condition) => {
    // Confirm the shape really is accepted at save time (guards the table
    // itself against a typo that would make this test pass vacuously).
    expect(() => parseContractLayout({
      blocks: [
        { kind: "agreement", id: "a1", title: "A", body: "", signatureLabel: "sign", visibleWhen: condition },
      ],
    })).not.toThrow();

    const parsed = parseFieldCondition(condition);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(condition);
  });
});
