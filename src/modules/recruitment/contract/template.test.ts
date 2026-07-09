import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  applyBlockOp,
  assertTwoTier,
  getContractLayoutForEdit,
  resetCycleContractLayout,
  saveCycleContractLayout,
  type BlockPatch,
} from "./template";
import { DEFAULT_CONTRACT_LAYOUT } from "./system-fields";
import { ContractLayoutError, type AgreementBlock, type CustomQuestionBlock } from "./layout";

describe("applyBlockOp", () => {
  it("adds an agreement with a unique id", () => {
    const out = applyBlockOp(DEFAULT_CONTRACT_LAYOUT, { t: "addAgreement" });
    expect(out.blocks.filter((b) => b.kind === "agreement").length)
      .toBe(DEFAULT_CONTRACT_LAYOUT.blocks.filter((b) => b.kind === "agreement").length + 1);
    const added = out.blocks.filter((b): b is AgreementBlock => b.kind === "agreement").at(-1)!;
    const existingIds = DEFAULT_CONTRACT_LAYOUT.blocks
      .filter((b): b is AgreementBlock => b.kind === "agreement")
      .map((b) => b.id);
    expect(existingIds).not.toContain(added.id);
  });

  it("adds a custom question with a unique, namespaced key", () => {
    const out = applyBlockOp(DEFAULT_CONTRACT_LAYOUT, { t: "addCustom", fieldType: "SHORT_TEXT" });
    const cq = out.blocks.find((b): b is CustomQuestionBlock => b.kind === "custom_question")!;
    expect(cq.key).toMatch(/^[a-z0-9_]+$/);
    expect(cq.type).toBe("SHORT_TEXT");
  });

  it("does not mutate the input layout", () => {
    const before = JSON.parse(JSON.stringify(DEFAULT_CONTRACT_LAYOUT));
    applyBlockOp(DEFAULT_CONTRACT_LAYOUT, { t: "addAgreement" });
    applyBlockOp(DEFAULT_CONTRACT_LAYOUT, { t: "addCustom", fieldType: "SHORT_TEXT" });
    applyBlockOp(DEFAULT_CONTRACT_LAYOUT, { t: "updateBlock", index: 0, patch: { label: "Full name" } });
    applyBlockOp(DEFAULT_CONTRACT_LAYOUT, { t: "removeBlock", index: 2 });
    applyBlockOp(DEFAULT_CONTRACT_LAYOUT, {
      t: "reorder",
      order: DEFAULT_CONTRACT_LAYOUT.blocks.map((_, i, arr) => arr.length - 1 - i),
    });
    const gradYearIdx = DEFAULT_CONTRACT_LAYOUT.blocks.findIndex(
      (b) => b.kind === "system_field" && b.systemKey === "gradYear"
    );
    applyBlockOp(DEFAULT_CONTRACT_LAYOUT, { t: "toggleSystem", index: gradYearIdx, enabled: false });
    expect(DEFAULT_CONTRACT_LAYOUT).toEqual(before);
  });

  it("updateBlock cannot rename an agreement's id (identity is immutable)", () => {
    const idx = DEFAULT_CONTRACT_LAYOUT.blocks.findIndex((b) => b.kind === "agreement");
    const original = DEFAULT_CONTRACT_LAYOUT.blocks[idx] as AgreementBlock;

    // BlockPatch excludes `id` at the type level, but a server action could still
    // pass an untyped object at runtime -- assert the identity field wins regardless.
    const untypedPatch = { title: "New title", id: "renamed" } as Record<string, unknown> as BlockPatch;
    const out = applyBlockOp(DEFAULT_CONTRACT_LAYOUT, { t: "updateBlock", index: idx, patch: untypedPatch });

    const patched = out.blocks[idx] as AgreementBlock;
    expect(patched.id).toBe(original.id);
    expect(patched.title).toBe("New title");
  });

  it("updateBlock cannot rename a custom question's key (identity is immutable)", () => {
    const withCustom = applyBlockOp(DEFAULT_CONTRACT_LAYOUT, { t: "addCustom", fieldType: "SHORT_TEXT" });
    const idx = withCustom.blocks.findIndex((b) => b.kind === "custom_question");
    const original = withCustom.blocks[idx] as CustomQuestionBlock;

    // BlockPatch excludes `key` at the type level, but a server action could still
    // pass an untyped object at runtime -- assert the identity field wins regardless.
    const untypedPatch = { label: "New label", key: "renamed" } as Record<string, unknown> as BlockPatch;
    const out = applyBlockOp(withCustom, { t: "updateBlock", index: idx, patch: untypedPatch });

    const patched = out.blocks[idx] as CustomQuestionBlock;
    expect(patched.key).toBe(original.key);
    expect(patched.label).toBe("New label");
  });

  it("updateBlock patches a block by index without mutating other blocks", () => {
    const out = applyBlockOp(DEFAULT_CONTRACT_LAYOUT, { t: "updateBlock", index: 0, patch: { label: "Full name" } });
    expect((out.blocks[0] as { label: string }).label).toBe("Full name");
    expect(out.blocks[1]).toEqual(DEFAULT_CONTRACT_LAYOUT.blocks[1]);
  });

  it("removeBlock drops the block at the given index", () => {
    const out = applyBlockOp(DEFAULT_CONTRACT_LAYOUT, { t: "removeBlock", index: 2 });
    expect(out.blocks.length).toBe(DEFAULT_CONTRACT_LAYOUT.blocks.length - 1);
    expect(out.blocks).not.toContainEqual(DEFAULT_CONTRACT_LAYOUT.blocks[2]);
  });

  it("reorder rearranges blocks per the given index permutation", () => {
    const reversedOrder = DEFAULT_CONTRACT_LAYOUT.blocks.map((_, i, arr) => arr.length - 1 - i);
    const out = applyBlockOp(DEFAULT_CONTRACT_LAYOUT, { t: "reorder", order: reversedOrder });
    expect(out.blocks[0]).toEqual(DEFAULT_CONTRACT_LAYOUT.blocks.at(-1));
    expect(out.blocks.length).toBe(DEFAULT_CONTRACT_LAYOUT.blocks.length);
  });

  it("toggleSystem flips enabled on a system_field block", () => {
    const idx = DEFAULT_CONTRACT_LAYOUT.blocks.findIndex((b) => b.kind === "system_field" && b.systemKey === "gradYear");
    const out = applyBlockOp(DEFAULT_CONTRACT_LAYOUT, { t: "toggleSystem", index: idx, enabled: false });
    expect((out.blocks[idx] as { enabled: boolean }).enabled).toBe(false);
  });

  it("removeBlock throws for an out-of-range index", () => {
    expect(() => applyBlockOp(DEFAULT_CONTRACT_LAYOUT, { t: "removeBlock", index: 999 })).toThrow(RangeError);
  });
});

describe("assertTwoTier", () => {
  it("rejects removing a core system field", () => {
    const noHipaa = { blocks: DEFAULT_CONTRACT_LAYOUT.blocks.filter((b) => !(b.kind === "system_field" && b.systemKey === "hipaa")) };
    expect(() => assertTwoTier(noHipaa)).toThrow(ContractLayoutError);
  });
  it("rejects disabling a core system field", () => {
    const disabled = { blocks: DEFAULT_CONTRACT_LAYOUT.blocks.map((b) => b.kind === "system_field" && b.systemKey === "epic" ? { ...b, enabled: false } : b) };
    expect(() => assertTwoTier(disabled)).toThrow(ContractLayoutError);
  });
  it("allows disabling an optional system field", () => {
    const disabled = { blocks: DEFAULT_CONTRACT_LAYOUT.blocks.map((b) => b.kind === "system_field" && b.systemKey === "gradYear" ? { ...b, enabled: false } : b) };
    expect(() => assertTwoTier(disabled)).not.toThrow();
  });
  it("rejects a duplicate system_field block", () => {
    const nameBlock = DEFAULT_CONTRACT_LAYOUT.blocks.find((b) => b.kind === "system_field" && b.systemKey === "name");
    const duped = { blocks: [...DEFAULT_CONTRACT_LAYOUT.blocks, nameBlock!] };
    expect(() => assertTwoTier(duped)).toThrow(ContractLayoutError);
  });
  it("passes for the untouched default layout", () => {
    expect(() => assertTwoTier(DEFAULT_CONTRACT_LAYOUT)).not.toThrow();
  });
});

describe("DB: getContractLayoutForEdit / saveCycleContractLayout / resetCycleContractLayout", () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(async () => { await resetDb(); });

  async function seedCycle() {
    const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
    const creator = await prisma.person.create({ data: { name: "Admin", status: "ACTIVE" } });
    return prisma.recruitmentCycle.create({
      data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v-template-test", createdById: creator.id, status: "OPEN" },
    });
  }

  it("round-trips a cycle override: save -> hasOverride true -> reset -> hasOverride false", async () => {
    const cycle = await seedCycle();

    const before = await getContractLayoutForEdit(cycle.id);
    expect(before.hasOverride).toBe(false);
    expect(before.layout.blocks).toEqual(DEFAULT_CONTRACT_LAYOUT.blocks);

    const customized = applyBlockOp(DEFAULT_CONTRACT_LAYOUT, { t: "addAgreement" });
    await saveCycleContractLayout(cycle.id, customized);

    const after = await getContractLayoutForEdit(cycle.id);
    expect(after.hasOverride).toBe(true);
    expect(after.layout.blocks).toEqual(customized.blocks);

    await resetCycleContractLayout(cycle.id);

    const reset = await getContractLayoutForEdit(cycle.id);
    expect(reset.hasOverride).toBe(false);
    expect(reset.layout.blocks).toEqual(DEFAULT_CONTRACT_LAYOUT.blocks);
  });

  it("saveCycleContractLayout refuses a layout that fails the two-tier guard", async () => {
    const cycle = await seedCycle();
    const noHipaa = { blocks: DEFAULT_CONTRACT_LAYOUT.blocks.filter((b) => !(b.kind === "system_field" && b.systemKey === "hipaa")) };
    await expect(saveCycleContractLayout(cycle.id, noHipaa)).rejects.toBeInstanceOf(ContractLayoutError);
    const row = await prisma.recruitmentCycleContract.findUnique({ where: { cycleId: cycle.id } });
    expect(row).toBeNull();
  });
});
