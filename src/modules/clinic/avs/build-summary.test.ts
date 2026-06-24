import { describe, expect, it } from "vitest";
import { buildSummary } from "./build-summary";
import type { AvsData } from "./types";

function base(overrides: Partial<AvsData> = {}): AvsData {
  return {
    firstName: "Maria",
    lastName: "Garcia",
    dob: "",
    visitDate: "2026-06-11",
    preferredLang: "en",
    provider: "",
    patientId: "",
    primaryReason: "Hypertension follow-up",
    diagnoses: "",
    clinicalNotes: "",
    vitals: [],
    medications: [],
    followUpTimeframe: "",
    followUpNote: "",
    labs: [],
    actionItems: [],
    lifestyle: "",
    communityResources: [],
    financialResources: [],
    customResource: "",
    ...overrides,
  };
}

describe("buildSummary", () => {
  it("includes patient and visit blocks for minimal data", () => {
    const s = buildSummary(base(), "en");
    expect(s.headerName).toBe("Maria Garcia");
    expect(s.docTitle).toBe("After Visit Summary");
    const headings = s.blocks.map((b) => b.heading);
    expect(headings).toEqual(["Patient information", "Visit details"]);
  });

  it("omits empty optional sections", () => {
    const s = buildSummary(base(), "en");
    const headings = s.blocks.map((b) => b.heading);
    expect(headings).not.toContain("Medications");
    expect(headings).not.toContain("Next steps");
    expect(headings).not.toContain("Resources");
  });

  it("localizes headings, labels, and option values in Spanish", () => {
    const s = buildSummary(base({ vitals: ["blood-pressure"] }), "es");
    expect(s.docTitle).toBe("Resumen de la visita");
    expect(s.blocks[0].heading).toBe("Información del paciente");
    const visit = s.blocks.find((b) => b.heading === "Detalles de la visita")!;
    const tags = visit.items.find((i) => i.kind === "tags");
    expect(tags).toMatchObject({ kind: "tags", values: ["Presión arterial"] });
  });

  it("formats the visit date in the chosen language", () => {
    expect(buildSummary(base(), "en").visitDateValue).toBe("June 11, 2026");
    expect(buildSummary(base(), "es").visitDateValue).toBe("11 de junio de 2026");
  });

  it("includes medications, dropping rows with a blank name", () => {
    const s = buildSummary(
      base({
        medications: [
          { name: "Lisinopril", dose: "10 mg daily", costSource: "$4 generic" },
          { name: "", dose: "ignored", costSource: "" },
        ],
      }),
      "en",
    );
    const meds = s.blocks.find((b) => b.heading === "Medications")!;
    const item = meds.items.find((i) => i.kind === "meds")!;
    expect(item).toMatchObject({ kind: "meds" });
    if (item.kind === "meds") {
      expect(item.meds).toHaveLength(1);
      expect(item.meds[0].name).toBe("Lisinopril");
    }
  });

  it("builds a next-steps block with follow-up, labs, actions, and lifestyle", () => {
    const s = buildSummary(
      base({
        followUpTimeframe: "3-months",
        followUpNote: "blood pressure check",
        labs: ["hba1c"],
        actionItems: ["Walk 30 min daily", ""],
        lifestyle: "Reduce sodium",
      }),
      "en",
    );
    const next = s.blocks.find((b) => b.heading === "Next steps")!;
    const followUp = next.items.find((i) => i.kind === "text" && i.label === "Follow-up");
    expect(followUp).toMatchObject({ value: "3 months, blood pressure check" });
    const actions = next.items.find((i) => i.kind === "list");
    expect(actions).toMatchObject({ values: ["Walk 30 min daily"] });
  });

  it("builds a resources block from community, financial, and custom entries", () => {
    const s = buildSummary(
      base({
        communityResources: ["food-pantry"],
        financialResources: ["snap"],
        customResource: "Local YMCA free membership",
      }),
      "en",
    );
    const res = s.blocks.find((b) => b.heading === "Resources")!;
    const labels = res.items.map((i) => i.label);
    expect(labels).toEqual([
      "Community resources",
      "Financial resources",
      "Additional resource",
    ]);
  });

  it("passes free text through unchanged", () => {
    const s = buildSummary(base({ diagnoses: "Hipertensión (I10)" }), "es");
    const visit = s.blocks.find((b) => b.heading === "Detalles de la visita")!;
    const dx = visit.items.find((i) => i.kind === "text" && i.label === "Diagnósticos / afecciones");
    expect(dx).toMatchObject({ value: "Hipertensión (I10)" });
  });
});
