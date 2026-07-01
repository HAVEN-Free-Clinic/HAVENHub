import { createElement, type ReactElement } from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";
import { AvsDocument, createAvsStyles, tint } from "./avs-pdf";
import { buildSummary } from "./build-summary";
import type { AvsData } from "./types";

const FULL: AvsData = {
  firstName: "Maria",
  lastName: "Garcia",
  dob: "1980-02-03",
  visitDate: "2026-06-11",
  preferredLang: "en",
  provider: "Dr. Smith",
  patientId: "HC-000001",
  primaryReason: "Hypertension follow-up",
  diagnoses: "Hypertension (I10)",
  clinicalNotes: "Blood pressure improved.",
  vitals: ["blood-pressure", "weight-bmi"],
  medications: [{ name: "Lisinopril", dose: "10 mg daily", costSource: "$4 generic" }],
  followUpTimeframe: "3-months",
  followUpNote: "BP check",
  labs: ["hba1c"],
  actionItems: ["Walk 30 min daily"],
  lifestyle: "Reduce sodium",
  communityResources: ["food-pantry"],
  financialResources: ["snap"],
  customResource: "Local YMCA",
};

describe("tint", () => {
  it("returns pure white at strength 0", () => {
    expect(tint("#00356b", 0)).toBe("#ffffff");
  });

  it("returns the color unchanged at strength 1", () => {
    expect(tint("#00356b", 1)).toBe("#00356b");
  });

  it("mixes black halfway to mid grey", () => {
    expect(tint("#000000", 0.5)).toBe("#808080");
  });
});

describe("createAvsStyles", () => {
  it("threads the brand color into every brand-dependent style", () => {
    const s = createAvsStyles("#aa1133");
    expect(s.docTitle.color).toBe("#aa1133");
    expect(s.heading.color).toBe("#aa1133");
    expect(s.header.borderBottomColor).toBe("#aa1133");
    expect(s.tag.color).toBe("#aa1133");
  });

  it("derives the tag chip background from the brand color, not a fixed hex", () => {
    const blue = createAvsStyles("#00356b").tag.backgroundColor;
    const green = createAvsStyles("#0a7d3c").tag.backgroundColor;
    expect(blue).not.toBe(green);
    expect(blue).toBe(tint("#00356b", 0.12));
  });
});

describe("AvsDocument", () => {
  it("renders a non-empty PDF in English", async () => {
    const el = createElement(AvsDocument, { summary: buildSummary(FULL, "en") }) as unknown as ReactElement<DocumentProps>;
    const buf = await renderToBuffer(el);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders a non-empty PDF in Spanish", async () => {
    const el = createElement(AvsDocument, { summary: buildSummary(FULL, "es") }) as unknown as ReactElement<DocumentProps>;
    const buf = await renderToBuffer(el);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
