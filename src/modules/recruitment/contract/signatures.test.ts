import { describe, expect, it } from "vitest";
import { collectSignatureInputs, buildContractSignatureView, isStoredSignature } from "./signatures";
import type { ContractLayout } from "./layout";

describe("collectSignatureInputs", () => {
  it("groups a base signature with its method and name companions", () => {
    const entries: [string, string][] = [
      ["sig__agreement", "data:image/png;base64,AAA"],
      ["sig__agreement__method", "draw"],
      ["sig__agreement__name", "Ada Lovelace"],
      ["sig__initials", "data:image/png;base64,BBB"],
      ["sig__initials__method", "type"],
      ["sig__initials__name", "AL"],
      ["unrelated", "ignore me"],
    ];
    const out = collectSignatureInputs(entries);
    expect(out.agreement).toEqual({ dataUrl: "data:image/png;base64,AAA", method: "draw", name: "Ada Lovelace" });
    expect(out.initials).toEqual({ dataUrl: "data:image/png;base64,BBB", method: "type", name: "AL" });
    expect(out.unrelated).toBeUndefined();
  });

  it("defaults method to draw and name to empty when companions are absent", () => {
    const out = collectSignatureInputs([["sig__training", "data:image/png;base64,CCC"]]);
    expect(out.training).toEqual({ dataUrl: "data:image/png;base64,CCC", method: "draw", name: "" });
  });
});

describe("buildContractSignatureView", () => {
  const layout: ContractLayout = {
    blocks: [
      { kind: "agreement", id: "agreement", title: "Volunteer agreement", body: "", signatureLabel: "sign" },
      { kind: "system_field", systemKey: "initials" },
    ],
  };

  it("maps a new drawn signature to an imageKey row", () => {
    const rows = buildContractSignatureView(layout, {
      agreement: { method: "draw", name: "Ada", imageKey: "onboarding/c1/sig-agreement.png", signedAt: "2026-07-15T00:00:00.000Z" },
    });
    const row = rows.find((r) => r.blockId === "agreement")!;
    expect(row.title).toBe("Volunteer agreement");
    expect(row.imageKey).toBe("onboarding/c1/sig-agreement.png");
    expect(row.legacyText).toBeNull();
    expect(row.name).toBe("Ada");
  });

  it("maps a legacy typed-name string to a legacyText row", () => {
    const rows = buildContractSignatureView(layout, { agreement: "Ada Lovelace" });
    const row = rows.find((r) => r.blockId === "agreement")!;
    expect(row.legacyText).toBe("Ada Lovelace");
    expect(row.imageKey).toBeNull();
  });

  it("includes an Initials row when the initials system field is enabled", () => {
    const rows = buildContractSignatureView(layout, {});
    expect(rows.some((r) => r.blockId === "initials" && r.title === "Initials")).toBe(true);
  });
});

describe("isStoredSignature", () => {
  it("accepts the stored object shape and rejects a plain string", () => {
    expect(isStoredSignature({ method: "draw", name: "x", imageKey: "k", signedAt: "t" })).toBe(true);
    expect(isStoredSignature("typed name")).toBe(false);
  });
});
