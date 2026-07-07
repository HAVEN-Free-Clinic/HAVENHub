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
});
