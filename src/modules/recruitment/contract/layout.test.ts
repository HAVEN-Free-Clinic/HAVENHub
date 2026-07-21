import { describe, it, expect } from "vitest";
import { parseContractLayout, ContractLayoutError } from "./layout";

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
