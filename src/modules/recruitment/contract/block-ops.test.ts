import { describe, it, expect } from "vitest";
import { applyBlockOp } from "./block-ops";

describe("section ops", () => {
  it("appends a section with a unique id", () => {
    const out = applyBlockOp({ blocks: [] }, { t: "addSection" });
    expect(out.blocks[0]).toMatchObject({ kind: "section", title: "New section", body: "" });
  });

  it("gives the second section a distinct id", () => {
    let l = applyBlockOp({ blocks: [] }, { t: "addSection" });
    l = applyBlockOp(l, { t: "addSection" });
    const [a, b] = l.blocks as unknown as [{ id: string }, { id: string }];
    expect(a.id).not.toEqual(b.id);
  });

  it("patches a section body without touching its id", () => {
    const l = applyBlockOp({ blocks: [] }, { t: "addSection" });
    const id = (l.blocks[0] as { id: string }).id;
    const out = applyBlockOp(l, { t: "updateBlock", index: 0, patch: { body: "hello", id: "hacked" } as never });
    expect(out.blocks[0]).toMatchObject({ id, body: "hello" });
  });

  it("patches visibleWhen onto an agreement", () => {
    const l = applyBlockOp({ blocks: [] }, { t: "addAgreement" });
    const out = applyBlockOp(l, {
      t: "updateBlock", index: 0,
      patch: { visibleWhen: { field: "department", op: "is", value: "BVHD" } },
    });
    expect(out.blocks[0].visibleWhen).toEqual({ field: "department", op: "is", value: "BVHD" });
  });
});
