import { describe, it, expect } from "vitest";
import { applyBlockOp } from "./block-ops";
import { parseContractLayout } from "./layout";
import type { AgreementBlock, ContractLayout, SectionBlock } from "./layout";

describe("section ops", () => {
  it("appends a section with a unique id", () => {
    const out = applyBlockOp({ blocks: [] }, { t: "addSection" });
    expect(out.blocks[0]).toMatchObject({ kind: "section", title: "New section", body: "" });
  });

  it("gives the second section a distinct id", () => {
    let l = applyBlockOp({ blocks: [] }, { t: "addSection" });
    l = applyBlockOp(l, { t: "addSection" });
    const [a, b] = l.blocks as [SectionBlock, SectionBlock];
    expect(a.id).not.toEqual(b.id);
  });

  it("patches a section body without touching its id", () => {
    const l = applyBlockOp({ blocks: [] }, { t: "addSection" });
    const id = (l.blocks[0] as { id: string }).id;
    const out = applyBlockOp(l, { t: "updateBlock", index: 0, patch: { body: "hello", id: "hacked" } as never });
    expect(out.blocks[0]).toMatchObject({ id, body: "hello" });
  });
});

describe("agreement ops", () => {
  it("patches visibleWhen onto an agreement", () => {
    const l = applyBlockOp({ blocks: [] }, { t: "addAgreement" });
    const out = applyBlockOp(l, {
      t: "updateBlock", index: 0,
      patch: { visibleWhen: { field: "department", op: "is", value: "BVHD" } },
    });
    expect(out.blocks[0].visibleWhen).toEqual({ field: "department", op: "is", value: "BVHD" });
  });
});

describe("cross-kind id generation", () => {
  it("gives a new section a different id when an agreement already owns id \"section\"", () => {
    const start: ContractLayout = {
      blocks: [{ kind: "agreement", id: "section", title: "T", body: "", signatureLabel: "sign" }],
    };
    const out = applyBlockOp(start, { t: "addSection" });
    const added = out.blocks[out.blocks.length - 1] as SectionBlock;
    expect(added.kind).toEqual("section");
    expect(added.id).not.toEqual("section");

    // parseContractLayout is what actually rejects a duplicate id across
    // agreement and section blocks (they share one id namespace), so this is
    // the assertion that pins the user-facing property: a collision here
    // would surface as an undiagnosable save failure in the form builder.
    expect(() => parseContractLayout(out)).not.toThrow();
  });

  it("gives a new agreement a different id when a section already owns id \"agreement\"", () => {
    const start: ContractLayout = {
      blocks: [{ kind: "section", id: "agreement", title: "T", body: "" }],
    };
    const out = applyBlockOp(start, { t: "addAgreement" });
    const added = out.blocks[out.blocks.length - 1] as AgreementBlock;
    expect(added.kind).toEqual("agreement");
    expect(added.id).not.toEqual("agreement");

    // Same reasoning as above: this is the assertion that actually pins the
    // user-facing property, since a duplicate id is exactly what
    // parseContractLayout rejects.
    expect(() => parseContractLayout(out)).not.toThrow();
  });

  it("keeps every id distinct across several sections added to a layout that already has agreements", () => {
    let l: ContractLayout = { blocks: [] };
    l = applyBlockOp(l, { t: "addAgreement" });
    l = applyBlockOp(l, { t: "addAgreement" });
    l = applyBlockOp(l, { t: "addSection" });
    l = applyBlockOp(l, { t: "addSection" });
    l = applyBlockOp(l, { t: "addSection" });

    const ids = l.blocks
      .filter((b): b is AgreementBlock | SectionBlock => b.kind === "agreement" || b.kind === "section")
      .map((b) => b.id);
    expect(ids.length).toEqual(new Set(ids).size);
  });
});
