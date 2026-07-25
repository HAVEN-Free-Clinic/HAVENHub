import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { setSetting, _resetSettingsCache } from "@/platform/settings/service";
import { resolveContractLayout, resolveLayoutSources, pickGlobalForTrack } from "./resolve";
import { DEFAULT_CONTRACT_LAYOUT, defaultContractLayout } from "./system-fields";
import type { AgreementBlock } from "./layout";

const agr = (id: string) => ({ blocks: [{ kind: "agreement", id, title: id, body: "", signatureLabel: "sign" }] });

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

describe("pickGlobalForTrack (#3)", () => {
  it("returns the track's entry from a per-track map", () => {
    const map = { VOLUNTEER: agr("vol_g"), DIRECTOR: agr("dir_g") };
    expect(pickGlobalForTrack(map, "DIRECTOR")).toEqual(agr("dir_g"));
    expect(pickGlobalForTrack(map, "VOLUNTEER")).toEqual(agr("vol_g"));
  });
  it("treats a legacy flat layout as the VOLUNTEER template only, never DIRECTOR", () => {
    const flat = agr("legacy_flat");
    expect(pickGlobalForTrack(flat, "VOLUNTEER")).toBe(flat);
    expect(pickGlobalForTrack(flat, "DIRECTOR")).toBeNull();
  });
  it("returns null for a track with no entry in the map", () => {
    expect(pickGlobalForTrack({ VOLUNTEER: agr("vol_g") }, "DIRECTOR")).toBeNull();
  });
});

describe("resolveContractLayout", () => {
  beforeEach(async () => { await resetDb(); _resetSettingsCache(); });
  afterEach(async () => { await resetDb(); _resetSettingsCache(); });

  async function makeCycle(track: "VOLUNTEER" | "DIRECTOR", slug: string) {
    // Term.code is unique, so derive it from the (unique) slug to allow two cycles per test.
    const term = await prisma.term.create({ data: { code: `T-${slug}`, name: "Fall", startDate: new Date(), endDate: new Date(), status: "PLANNING" } });
    const creator = await prisma.person.create({ data: { name: "Admin", status: "ACTIVE" } });
    return prisma.recruitmentCycle.create({
      data: { track, termId: term.id, title: track, publicSlug: slug, createdById: creator.id, status: "OPEN" },
    });
  }
  const ids = (l: { blocks: { kind: string }[] }) =>
    l.blocks.filter((b): b is AgreementBlock => b.kind === "agreement").map((b) => b.id);

  it("falls back to the director default for a director cycle with no overrides", async () => {
    const cycle = await makeCycle("DIRECTOR", "d-resolve-test");
    expect(ids(await resolveContractLayout(cycle.id))).toContain("data_privacy");
  });

  it("does not leak a legacy flat global template onto a DIRECTOR cycle, but keeps it for VOLUNTEER (#3)", async () => {
    // A legacy flat master template (the volunteer layout the old global editor always produced).
    await setSetting("onboarding.contractTemplate", agr("legacy_only"), null);
    const dir = await makeCycle("DIRECTOR", "d-leak");
    const vol = await makeCycle("VOLUNTEER", "v-leak");

    const dirIds = ids(await resolveContractLayout(dir.id));
    expect(dirIds).not.toContain("legacy_only"); // no leak onto directors
    expect(dirIds).toContain("data_privacy"); // director code default instead

    // The volunteer cycle still gets it -- it WAS the volunteer template.
    expect(ids(await resolveContractLayout(vol.id))).toEqual(["legacy_only"]);
  });

  it("picks the per-track master template by the cycle's track (#3)", async () => {
    await setSetting("onboarding.contractTemplate", { VOLUNTEER: agr("vol_g"), DIRECTOR: agr("dir_g") }, null);
    const dir = await makeCycle("DIRECTOR", "d-map");
    const vol = await makeCycle("VOLUNTEER", "v-map");
    expect(ids(await resolveContractLayout(dir.id))).toEqual(["dir_g"]);
    expect(ids(await resolveContractLayout(vol.id))).toEqual(["vol_g"]);
  });
});
