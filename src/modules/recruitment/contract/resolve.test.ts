import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { resolveContractLayout, resolveLayoutSources } from "./resolve";
import { DEFAULT_CONTRACT_LAYOUT, defaultContractLayout } from "./system-fields";
import type { AgreementBlock } from "./layout";

describe("resolveLayoutSources", () => {
  it("prefers the cycle override", () => {
    const override = { blocks: [{ kind: "agreement", id: "x", title: "X", body: "hi", signatureLabel: "sign" }] };
    expect(resolveLayoutSources(override, null, "VOLUNTEER").blocks).toHaveLength(1);
  });
  it("falls back to the global default", () => {
    const global = { blocks: [{ kind: "system_field", systemKey: "name" }] };
    expect(resolveLayoutSources(null, global, "VOLUNTEER").blocks[0]).toMatchObject({ systemKey: "name" });
  });
  it("falls back to the code default when both are null", () => {
    expect(resolveLayoutSources(null, null, "VOLUNTEER").blocks).toEqual(DEFAULT_CONTRACT_LAYOUT.blocks);
  });
  it("falls back to the code default when a stored value is malformed", () => {
    expect(resolveLayoutSources({ garbage: true }, null, "VOLUNTEER").blocks).toEqual(DEFAULT_CONTRACT_LAYOUT.blocks);
  });
  it("prefers the cycle override over a non-null global default", () => {
    const cycle = { blocks: [{ kind: "agreement", id: "c", title: "Cycle", body: "", signatureLabel: "sign" }] };
    const global = { blocks: [{ kind: "agreement", id: "g", title: "Global", body: "", signatureLabel: "sign" }] };
    const out = resolveLayoutSources(cycle, global, "VOLUNTEER");
    expect(out.blocks).toHaveLength(1);
    expect((out.blocks[0] as { id: string }).id).toBe("c");
  });
  it("falls back to the director default when both are null and track is DIRECTOR", () => {
    expect(resolveLayoutSources(null, null, "DIRECTOR").blocks).toEqual(defaultContractLayout("DIRECTOR").blocks);
  });
});

describe("resolveContractLayout", () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(async () => { await resetDb(); });

  it("falls back to the director default for a director cycle with no overrides", async () => {
    const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
    const creator = await prisma.person.create({ data: { name: "Admin", status: "ACTIVE" } });
    const cycle = await prisma.recruitmentCycle.create({
      data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d-resolve-test", createdById: creator.id, status: "OPEN" },
    });

    const layout = await resolveContractLayout(cycle.id);
    const agreementIds = layout.blocks.filter((b): b is AgreementBlock => b.kind === "agreement").map((b) => b.id);
    expect(agreementIds).toContain("data_privacy");
  });
});
