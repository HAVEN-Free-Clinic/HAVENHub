# After Visit Summary (AVS) Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a client-side, ephemeral tool at `/clinic/avs` where a clinical volunteer fills a short form during a visit and downloads a branded After Visit Summary PDF in English or Spanish.

**Architecture:** Everything runs in the browser. A server component gates the route with `requirePersonSession()`; a client component holds form state in a `useReducer`. On generate, a pure function maps form state to a localized summary model, which `@react-pdf/renderer` turns into a PDF blob and downloads. No API route, no server action, no database, no PHI at rest. Controlled vocabulary (headings, labels, option lists) is translated via a static EN/ES table; the four free-text fields print as typed.

**Tech Stack:** Next.js 16 (App Router) + React 19, TypeScript, Tailwind v4, Vitest, `@react-pdf/renderer` (new), existing HAVEN Hub UI kit under `@/platform/ui/*`.

**Spec:** `docs/superpowers/specs/2026-06-11-avs-generator-design.md`

---

## File Structure

Feature-grouped under a new `clinic` module; tests co-located as `*.test.ts` (matches the repo convention).

```
src/modules/clinic/avs/
  types.ts            # AvsData form type + summary model types + Lang
  strings.ts          # EN/ES dictionaries + localized option lists + helpers
  strings.test.ts     # EN/ES parity + non-empty assertions
  build-summary.ts    # buildSummary(data, lang) -> LocalizedSummary (pure)
  build-summary.test.ts
  form-state.ts       # initialAvsData + reducer (pure)
  form-state.test.ts
  avs-pdf.tsx         # <AvsDocument summary> @react-pdf/renderer Document
  avs-pdf.test.ts     # renderToBuffer smoke test (EN + ES)
  avs-tool.tsx        # 'use client' form: state, validation, generate+download
src/app/clinic/
  layout.tsx          # AppShell + ModuleNav, gated by requirePersonSession()
  avs/page.tsx        # server component, renders <AvsTool />
src/platform/modules/registry.ts   # MODIFY: add "clinic" module for nav
```

---

## Task 1: Add the `@react-pdf/renderer` dependency

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install the package**

Run: `npm install @react-pdf/renderer@^4`
Expected: installs cleanly; `package.json` gains `"@react-pdf/renderer": "^4.x"` under `dependencies`.

- [ ] **Step 2: Verify it imports under Node**

Run: `node -e "const r=require('@react-pdf/renderer'); console.log(typeof r.renderToBuffer)"`
Expected: prints `function`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(avs): add @react-pdf/renderer for client-side PDF generation"
```

---

## Task 2: Types + strings (EN/ES dictionaries)

**Files:**
- Create: `src/modules/clinic/avs/types.ts`
- Create: `src/modules/clinic/avs/strings.ts`
- Test: `src/modules/clinic/avs/strings.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/clinic/avs/strings.test.ts
import { describe, expect, it } from "vitest";
import {
  STRINGS,
  VITALS,
  LABS,
  FOLLOW_UP,
  COMMUNITY_RESOURCES,
  FINANCIAL_RESOURCES,
  optionLabel,
  type OptionList,
} from "./strings";

describe("STRINGS dictionaries", () => {
  it("has identical key sets for en and es", () => {
    expect(Object.keys(STRINGS.en).sort()).toEqual(Object.keys(STRINGS.es).sort());
  });

  it("has no empty values in either language", () => {
    for (const lang of ["en", "es"] as const) {
      for (const [key, value] of Object.entries(STRINGS[lang])) {
        expect(value, `${lang}.${key}`).toBeTruthy();
      }
    }
  });
});

describe("option lists", () => {
  const lists: Record<string, OptionList> = {
    VITALS,
    LABS,
    FOLLOW_UP,
    COMMUNITY_RESOURCES,
    FINANCIAL_RESOURCES,
  };

  it("every entry has a stable key plus non-empty en and es labels", () => {
    for (const [name, list] of Object.entries(lists)) {
      for (const opt of list) {
        expect(opt.key, `${name} key`).toBeTruthy();
        expect(opt.en, `${name}.${opt.key}.en`).toBeTruthy();
        expect(opt.es, `${name}.${opt.key}.es`).toBeTruthy();
      }
    }
  });

  it("has unique keys within each list", () => {
    for (const [name, list] of Object.entries(lists)) {
      const keys = list.map((o) => o.key);
      expect(new Set(keys).size, name).toBe(keys.length);
    }
  });
});

describe("optionLabel", () => {
  it("returns the language-specific label", () => {
    expect(optionLabel(VITALS, "blood-pressure", "en")).toBe("Blood pressure");
    expect(optionLabel(VITALS, "blood-pressure", "es")).toBe("Presión arterial");
  });

  it("falls back to the key when not found", () => {
    expect(optionLabel(VITALS, "nope", "en")).toBe("nope");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/clinic/avs/strings.test.ts`
Expected: FAIL — cannot find module `./strings`.

- [ ] **Step 3: Create the types file**

```typescript
// src/modules/clinic/avs/types.ts
export type Lang = "en" | "es";

export type Medication = {
  name: string;
  dose: string;
  costSource: string;
};

/** Raw form state. Free-text fields are printed as typed. */
export type AvsData = {
  firstName: string;
  lastName: string;
  dob: string; // ISO yyyy-mm-dd or ""
  visitDate: string; // ISO yyyy-mm-dd or ""
  preferredLang: Lang; // chosen language for the generated PDF
  provider: string;
  patientId: string;
  primaryReason: string;
  diagnoses: string;
  clinicalNotes: string;
  vitals: string[]; // VITALS keys
  medications: Medication[];
  followUpTimeframe: string; // FOLLOW_UP key or ""
  followUpNote: string;
  labs: string[]; // LABS keys
  actionItems: string[];
  lifestyle: string;
  communityResources: string[]; // COMMUNITY_RESOURCES keys
  financialResources: string[]; // FINANCIAL_RESOURCES keys
  customResource: string;
};

/** Localized, render-ready summary model produced by buildSummary. */
export type SummaryItem =
  | { kind: "text"; label: string; value: string }
  | { kind: "tags"; label: string; values: string[] }
  | { kind: "list"; label: string; values: string[] }
  | { kind: "meds"; label: string; meds: Medication[] };

export type SummaryBlock = {
  heading: string;
  items: SummaryItem[];
};

export type LocalizedSummary = {
  lang: Lang;
  docTitle: string;
  headerName: string;
  visitDateLabel: string; // localized "Visit date" label
  visitDateValue: string; // localized formatted date
  blocks: SummaryBlock[];
  disclaimer: string;
};
```

- [ ] **Step 4: Create the strings file**

```typescript
// src/modules/clinic/avs/strings.ts
import type { Lang } from "./types";

export type AvsStrings = {
  docTitle: string;
  sectionPatient: string;
  sectionVisit: string;
  sectionMeds: string;
  sectionNextSteps: string;
  sectionResources: string;
  labelVisitDate: string;
  labelProvider: string;
  labelDob: string;
  labelPatientId: string;
  labelPrimaryReason: string;
  labelDiagnoses: string;
  labelClinicalNotes: string;
  labelVitals: string;
  labelMedication: string;
  labelDose: string;
  labelCostSource: string;
  labelFollowUp: string;
  labelLabs: string;
  labelActionItems: string;
  labelLifestyle: string;
  labelCommunityResources: string;
  labelFinancialResources: string;
  labelCustomResource: string;
  disclaimer: string;
};

export const STRINGS: Record<Lang, AvsStrings> = {
  en: {
    docTitle: "After Visit Summary",
    sectionPatient: "Patient information",
    sectionVisit: "Visit details",
    sectionMeds: "Medications",
    sectionNextSteps: "Next steps",
    sectionResources: "Resources",
    labelVisitDate: "Visit date",
    labelProvider: "Provider",
    labelDob: "Date of birth",
    labelPatientId: "Patient ID",
    labelPrimaryReason: "Reason for visit",
    labelDiagnoses: "Diagnoses / conditions",
    labelClinicalNotes: "Notes",
    labelVitals: "Vitals reviewed",
    labelMedication: "Medication",
    labelDose: "Dose & instructions",
    labelCostSource: "Lowest-cost source",
    labelFollowUp: "Follow-up",
    labelLabs: "Labs / tests ordered",
    labelActionItems: "Action items",
    labelLifestyle: "Lifestyle recommendations",
    labelCommunityResources: "Community resources",
    labelFinancialResources: "Financial resources",
    labelCustomResource: "Additional resource",
    disclaimer:
      "This summary is for your records and is not a complete medical record. Contact the clinic with any questions.",
  },
  es: {
    docTitle: "Resumen de la visita",
    sectionPatient: "Información del paciente",
    sectionVisit: "Detalles de la visita",
    sectionMeds: "Medicamentos",
    sectionNextSteps: "Próximos pasos",
    sectionResources: "Recursos",
    labelVisitDate: "Fecha de la visita",
    labelProvider: "Proveedor",
    labelDob: "Fecha de nacimiento",
    labelPatientId: "Identificación del paciente",
    labelPrimaryReason: "Motivo de la visita",
    labelDiagnoses: "Diagnósticos / afecciones",
    labelClinicalNotes: "Notas",
    labelVitals: "Signos vitales revisados",
    labelMedication: "Medicamento",
    labelDose: "Dosis e instrucciones",
    labelCostSource: "Fuente de menor costo",
    labelFollowUp: "Seguimiento",
    labelLabs: "Laboratorios / pruebas ordenadas",
    labelActionItems: "Tareas a seguir",
    labelLifestyle: "Recomendaciones de estilo de vida",
    labelCommunityResources: "Recursos comunitarios",
    labelFinancialResources: "Recursos financieros",
    labelCustomResource: "Recurso adicional",
    disclaimer:
      "Este resumen es para sus registros y no es un expediente médico completo. Comuníquese con la clínica si tiene preguntas.",
  },
};

export type Option = { key: string; en: string; es: string };
export type OptionList = Option[];

export const VITALS: OptionList = [
  { key: "blood-pressure", en: "Blood pressure", es: "Presión arterial" },
  { key: "weight-bmi", en: "Weight / BMI", es: "Peso / IMC" },
  { key: "blood-glucose", en: "Blood glucose", es: "Glucosa en sangre" },
  { key: "hba1c", en: "HbA1c", es: "HbA1c" },
  { key: "cholesterol", en: "Cholesterol", es: "Colesterol" },
  { key: "temperature", en: "Temperature", es: "Temperatura" },
  { key: "o2-sat", en: "Oxygen saturation", es: "Saturación de oxígeno" },
];

export const LABS: OptionList = [
  { key: "hba1c", en: "HbA1c", es: "HbA1c" },
  { key: "cbc", en: "Complete blood count (CBC)", es: "Hemograma completo (CBC)" },
  { key: "bmp-cmp", en: "Metabolic panel (BMP/CMP)", es: "Panel metabólico (BMP/CMP)" },
  { key: "lipid-panel", en: "Lipid panel", es: "Panel de lípidos" },
  { key: "tsh", en: "TSH", es: "TSH" },
  { key: "urinalysis", en: "Urinalysis", es: "Análisis de orina" },
  { key: "chest-xray", en: "Chest X-ray", es: "Radiografía de tórax" },
  { key: "ekg", en: "EKG", es: "Electrocardiograma (EKG)" },
];

export const FOLLOW_UP: OptionList = [
  { key: "1-week", en: "1 week", es: "1 semana" },
  { key: "2-weeks", en: "2 weeks", es: "2 semanas" },
  { key: "1-month", en: "1 month", es: "1 mes" },
  { key: "3-months", en: "3 months", es: "3 meses" },
  { key: "6-months", en: "6 months", es: "6 meses" },
  { key: "1-year", en: "1 year", es: "1 año" },
  { key: "as-needed", en: "As needed", es: "Según sea necesario" },
  { key: "none", en: "No follow-up needed", es: "No se necesita seguimiento" },
];

export const COMMUNITY_RESOURCES: OptionList = [
  { key: "food-pantry", en: "Food pantry", es: "Despensa de alimentos" },
  { key: "transportation", en: "Transportation assistance", es: "Asistencia de transporte" },
  { key: "housing", en: "Housing support", es: "Apoyo de vivienda" },
  { key: "rx-assist", en: "Prescription assistance (RxAssist)", es: "Asistencia con medicamentos (RxAssist)" },
  { key: "dental", en: "Dental care (sliding scale)", es: "Atención dental (escala móvil)" },
  { key: "vision", en: "Vision care (sliding scale)", es: "Atención de la vista (escala móvil)" },
  { key: "mental-health", en: "Mental health services", es: "Servicios de salud mental" },
  { key: "wic", en: "WIC / nutrition support", es: "WIC / apoyo nutricional" },
];

export const FINANCIAL_RESOURCES: OptionList = [
  { key: "medicaid-help", en: "Medicaid application help", es: "Ayuda con la solicitud de Medicaid" },
  { key: "snap", en: "SNAP / food benefits", es: "SNAP / beneficios de alimentos" },
  { key: "utility-liheap", en: "Utility assistance (LIHEAP)", es: "Asistencia con servicios públicos (LIHEAP)" },
  { key: "self-referral-guide", en: "How to make your own referral", es: "Cómo hacer su propia referencia" },
  { key: "free-care-guide", en: "Free care eligibility guide", es: "Guía de elegibilidad para atención gratuita" },
];

export function optionLabel(list: OptionList, key: string, lang: Lang): string {
  const opt = list.find((o) => o.key === key);
  if (!opt) return key;
  return lang === "es" ? opt.es : opt.en;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/modules/clinic/avs/strings.test.ts`
Expected: PASS (3 describe blocks, all green).

- [ ] **Step 6: Commit**

```bash
git add src/modules/clinic/avs/types.ts src/modules/clinic/avs/strings.ts src/modules/clinic/avs/strings.test.ts
git commit -m "feat(avs): types and bilingual string tables"
```

---

## Task 3: `buildSummary` — form state to localized model

**Files:**
- Create: `src/modules/clinic/avs/build-summary.ts`
- Test: `src/modules/clinic/avs/build-summary.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/clinic/avs/build-summary.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/clinic/avs/build-summary.test.ts`
Expected: FAIL — cannot find module `./build-summary`.

- [ ] **Step 3: Implement `build-summary.ts`**

```typescript
// src/modules/clinic/avs/build-summary.ts
import type {
  AvsData,
  Lang,
  LocalizedSummary,
  SummaryBlock,
  SummaryItem,
} from "./types";
import {
  COMMUNITY_RESOURCES,
  FINANCIAL_RESOURCES,
  FOLLOW_UP,
  LABS,
  STRINGS,
  VITALS,
  optionLabel,
  type OptionList,
} from "./strings";

function formatDate(iso: string, lang: Lang): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  return new Intl.DateTimeFormat(lang === "es" ? "es" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function textItem(label: string, value: string): SummaryItem | null {
  const v = value.trim();
  return v ? { kind: "text", label, value: v } : null;
}

function tagsItem(label: string, keys: string[], list: OptionList, lang: Lang): SummaryItem | null {
  if (keys.length === 0) return null;
  return { kind: "tags", label, values: keys.map((k) => optionLabel(list, k, lang)) };
}

function listItem(label: string, values: string[]): SummaryItem | null {
  const cleaned = values.map((v) => v.trim()).filter(Boolean);
  return cleaned.length ? { kind: "list", label, values: cleaned } : null;
}

function block(heading: string, items: Array<SummaryItem | null>): SummaryBlock | null {
  const real = items.filter((i): i is SummaryItem => i !== null);
  return real.length ? { heading, items: real } : null;
}

export function buildSummary(data: AvsData, lang: Lang): LocalizedSummary {
  const t = STRINGS[lang];

  const patient = block(t.sectionPatient, [
    textItem(t.labelVisitDate, formatDate(data.visitDate, lang)),
    textItem(t.labelProvider, data.provider),
    textItem(t.labelDob, formatDate(data.dob, lang)),
    textItem(t.labelPatientId, data.patientId),
  ]);

  const visit = block(t.sectionVisit, [
    textItem(t.labelPrimaryReason, data.primaryReason),
    textItem(t.labelDiagnoses, data.diagnoses),
    textItem(t.labelClinicalNotes, data.clinicalNotes),
    tagsItem(t.labelVitals, data.vitals, VITALS, lang),
  ]);

  const validMeds = data.medications.filter((m) => m.name.trim());
  const meds = validMeds.length
    ? block(t.sectionMeds, [{ kind: "meds", label: t.sectionMeds, meds: validMeds }])
    : null;

  const followUpValue = [
    data.followUpTimeframe ? optionLabel(FOLLOW_UP, data.followUpTimeframe, lang) : "",
    data.followUpNote.trim(),
  ]
    .filter(Boolean)
    .join(", ");

  const nextSteps = block(t.sectionNextSteps, [
    textItem(t.labelFollowUp, followUpValue),
    tagsItem(t.labelLabs, data.labs, LABS, lang),
    listItem(t.labelActionItems, data.actionItems),
    textItem(t.labelLifestyle, data.lifestyle),
  ]);

  const resources = block(t.sectionResources, [
    tagsItem(t.labelCommunityResources, data.communityResources, COMMUNITY_RESOURCES, lang),
    tagsItem(t.labelFinancialResources, data.financialResources, FINANCIAL_RESOURCES, lang),
    textItem(t.labelCustomResource, data.customResource),
  ]);

  const blocks = [patient, visit, meds, nextSteps, resources].filter(
    (b): b is SummaryBlock => b !== null,
  );

  return {
    lang,
    docTitle: t.docTitle,
    headerName: `${data.firstName} ${data.lastName}`.trim(),
    visitDateLabel: t.labelVisitDate,
    visitDateValue: formatDate(data.visitDate, lang),
    blocks,
    disclaimer: t.disclaimer,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/clinic/avs/build-summary.test.ts`
Expected: PASS (all cases). If the Spanish date case fails on a label-only difference (locale data), confirm the exact ICU output with `node -e "console.log(new Intl.DateTimeFormat('es',{year:'numeric',month:'long',day:'numeric'}).format(new Date(2026,5,11)))"` and align the expectation; do not weaken the assertion otherwise.

- [ ] **Step 5: Commit**

```bash
git add src/modules/clinic/avs/build-summary.ts src/modules/clinic/avs/build-summary.test.ts
git commit -m "feat(avs): buildSummary maps form state to a localized model"
```

---

## Task 4: PDF document + smoke test

**Files:**
- Create: `src/modules/clinic/avs/avs-pdf.tsx`
- Test: `src/modules/clinic/avs/avs-pdf.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/clinic/avs/avs-pdf.test.ts
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";
import { AvsDocument } from "./avs-pdf";
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

describe("AvsDocument", () => {
  it("renders a non-empty PDF in English", async () => {
    const buf = await renderToBuffer(createElement(AvsDocument, { summary: buildSummary(FULL, "en") }));
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders a non-empty PDF in Spanish", async () => {
    const buf = await renderToBuffer(createElement(AvsDocument, { summary: buildSummary(FULL, "es") }));
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/clinic/avs/avs-pdf.test.ts`
Expected: FAIL — cannot find module `./avs-pdf`.

> If instead it fails while importing `@react-pdf/renderer` (ESM interop under Vitest), add `@react-pdf/renderer` to inlined deps in `vitest.config.ts` by adding `server: { deps: { inline: ["@react-pdf/renderer"] } }` inside the `test` block, then re-run. This is the only allowed config change.

- [ ] **Step 3: Implement `avs-pdf.tsx`**

```tsx
// src/modules/clinic/avs/avs-pdf.tsx
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { LocalizedSummary, SummaryItem } from "./types";

const BRAND = "#00356b";
const INK = "#1c2b2d";
const MUTED = "#5c7073";

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 10, color: INK, fontFamily: "Helvetica", lineHeight: 1.5 },
  header: { borderBottomWidth: 2, borderBottomColor: BRAND, paddingBottom: 8, marginBottom: 14 },
  docTitle: { fontSize: 16, color: BRAND, fontFamily: "Helvetica-Bold" },
  headerName: { fontSize: 12, marginTop: 2 },
  headerDate: { fontSize: 10, color: MUTED, marginTop: 2 },
  block: { marginBottom: 14 },
  heading: {
    fontSize: 8,
    letterSpacing: 1,
    color: BRAND,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    borderBottomWidth: 1,
    borderBottomColor: "#dde8e9",
    paddingBottom: 3,
    marginBottom: 6,
  },
  item: { marginBottom: 6 },
  label: { fontSize: 8, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 1 },
  value: { fontSize: 10 },
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  tag: { backgroundColor: "#e6f0f5", color: BRAND, fontSize: 9, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 4 },
  listItem: { flexDirection: "row", marginBottom: 2 },
  bullet: { width: 10, fontSize: 10 },
  medRow: { borderBottomWidth: 1, borderBottomColor: "#eef1f5", paddingBottom: 4, marginBottom: 4 },
  medName: { fontSize: 10, fontFamily: "Helvetica-Bold" },
  medDetail: { fontSize: 9, color: MUTED },
  footer: { marginTop: 18, paddingTop: 8, borderTopWidth: 1, borderTopColor: "#dde8e9", fontSize: 8, color: MUTED },
});

function Item({ item }: { item: SummaryItem }) {
  if (item.kind === "text") {
    return (
      <View style={styles.item}>
        <Text style={styles.label}>{item.label}</Text>
        <Text style={styles.value}>{item.value}</Text>
      </View>
    );
  }
  if (item.kind === "tags") {
    return (
      <View style={styles.item}>
        <Text style={styles.label}>{item.label}</Text>
        <View style={styles.tagRow}>
          {item.values.map((v, i) => (
            <Text key={i} style={styles.tag}>
              {v}
            </Text>
          ))}
        </View>
      </View>
    );
  }
  if (item.kind === "list") {
    return (
      <View style={styles.item}>
        <Text style={styles.label}>{item.label}</Text>
        {item.values.map((v, i) => (
          <View key={i} style={styles.listItem}>
            <Text style={styles.bullet}>•</Text>
            <Text style={styles.value}>{v}</Text>
          </View>
        ))}
      </View>
    );
  }
  return (
    <View style={styles.item}>
      {item.meds.map((m, i) => (
        <View key={i} style={styles.medRow}>
          <Text style={styles.medName}>{m.name}</Text>
          {m.dose.trim() ? <Text style={styles.medDetail}>{m.dose}</Text> : null}
          {m.costSource.trim() ? <Text style={styles.medDetail}>{m.costSource}</Text> : null}
        </View>
      ))}
    </View>
  );
}

export function AvsDocument({ summary }: { summary: LocalizedSummary }) {
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.docTitle}>{summary.docTitle}</Text>
          {summary.headerName ? <Text style={styles.headerName}>{summary.headerName}</Text> : null}
          {summary.visitDateValue ? (
            <Text style={styles.headerDate}>
              {summary.visitDateLabel}: {summary.visitDateValue}
            </Text>
          ) : null}
        </View>
        {summary.blocks.map((b, i) => (
          <View key={i} style={styles.block} wrap={false}>
            <Text style={styles.heading}>{b.heading}</Text>
            {b.items.map((item, j) => (
              <Item key={j} item={item} />
            ))}
          </View>
        ))}
        <Text style={styles.footer}>{summary.disclaimer}</Text>
      </Page>
    </Document>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/clinic/avs/avs-pdf.test.ts`
Expected: PASS — both buffers start with `%PDF-` and exceed 1000 bytes.

- [ ] **Step 5: Commit**

```bash
git add src/modules/clinic/avs/avs-pdf.tsx src/modules/clinic/avs/avs-pdf.test.ts vitest.config.ts
git commit -m "feat(avs): branded PDF document with smoke tests"
```

---

## Task 5: Form state reducer

**Files:**
- Create: `src/modules/clinic/avs/form-state.ts`
- Test: `src/modules/clinic/avs/form-state.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/clinic/avs/form-state.test.ts
import { describe, expect, it } from "vitest";
import { avsReducer, initialAvsData } from "./form-state";

describe("avsReducer", () => {
  it("sets a string field", () => {
    const s = avsReducer(initialAvsData, { type: "setField", key: "lastName", value: "Garcia" });
    expect(s.lastName).toBe("Garcia");
  });

  it("sets the language", () => {
    expect(avsReducer(initialAvsData, { type: "setLang", value: "es" }).preferredLang).toBe("es");
  });

  it("toggles an array value on and off", () => {
    const on = avsReducer(initialAvsData, { type: "toggle", key: "vitals", value: "blood-pressure" });
    expect(on.vitals).toEqual(["blood-pressure"]);
    const off = avsReducer(on, { type: "toggle", key: "vitals", value: "blood-pressure" });
    expect(off.vitals).toEqual([]);
  });

  it("adds, updates, and removes medications", () => {
    const a = avsReducer(initialAvsData, { type: "addMed" });
    expect(a.medications).toHaveLength(1);
    const b = avsReducer(a, { type: "updateMed", index: 0, key: "name", value: "Lisinopril" });
    expect(b.medications[0].name).toBe("Lisinopril");
    const c = avsReducer(b, { type: "removeMed", index: 0 });
    expect(c.medications).toHaveLength(0);
  });

  it("adds, updates, and removes action items", () => {
    const a = avsReducer(initialAvsData, { type: "addActionItem" });
    expect(a.actionItems).toEqual([""]);
    const b = avsReducer(a, { type: "updateActionItem", index: 0, value: "Walk daily" });
    expect(b.actionItems).toEqual(["Walk daily"]);
    const c = avsReducer(b, { type: "removeActionItem", index: 0 });
    expect(c.actionItems).toEqual([]);
  });

  it("does not mutate the previous state", () => {
    const next = avsReducer(initialAvsData, { type: "addMed" });
    expect(initialAvsData.medications).toHaveLength(0);
    expect(next).not.toBe(initialAvsData);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/clinic/avs/form-state.test.ts`
Expected: FAIL — cannot find module `./form-state`.

- [ ] **Step 3: Implement `form-state.ts`**

```typescript
// src/modules/clinic/avs/form-state.ts
import type { AvsData, Lang, Medication } from "./types";

export const initialAvsData: AvsData = {
  firstName: "",
  lastName: "",
  dob: "",
  visitDate: "",
  preferredLang: "en",
  provider: "",
  patientId: "",
  primaryReason: "",
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
};

export type StringFieldKey =
  | "firstName"
  | "lastName"
  | "dob"
  | "visitDate"
  | "provider"
  | "patientId"
  | "primaryReason"
  | "diagnoses"
  | "clinicalNotes"
  | "followUpTimeframe"
  | "followUpNote"
  | "lifestyle"
  | "customResource";

export type ArrayFieldKey = "vitals" | "labs" | "communityResources" | "financialResources";

export type AvsAction =
  | { type: "setField"; key: StringFieldKey; value: string }
  | { type: "setLang"; value: Lang }
  | { type: "toggle"; key: ArrayFieldKey; value: string }
  | { type: "addMed" }
  | { type: "updateMed"; index: number; key: keyof Medication; value: string }
  | { type: "removeMed"; index: number }
  | { type: "addActionItem" }
  | { type: "updateActionItem"; index: number; value: string }
  | { type: "removeActionItem"; index: number };

export function avsReducer(state: AvsData, action: AvsAction): AvsData {
  switch (action.type) {
    case "setField":
      return { ...state, [action.key]: action.value };
    case "setLang":
      return { ...state, preferredLang: action.value };
    case "toggle": {
      const current = state[action.key];
      const next = current.includes(action.value)
        ? current.filter((v) => v !== action.value)
        : [...current, action.value];
      return { ...state, [action.key]: next };
    }
    case "addMed":
      return { ...state, medications: [...state.medications, { name: "", dose: "", costSource: "" }] };
    case "updateMed":
      return {
        ...state,
        medications: state.medications.map((m, i) =>
          i === action.index ? { ...m, [action.key]: action.value } : m,
        ),
      };
    case "removeMed":
      return { ...state, medications: state.medications.filter((_, i) => i !== action.index) };
    case "addActionItem":
      return { ...state, actionItems: [...state.actionItems, ""] };
    case "updateActionItem":
      return {
        ...state,
        actionItems: state.actionItems.map((v, i) => (i === action.index ? action.value : v)),
      };
    case "removeActionItem":
      return { ...state, actionItems: state.actionItems.filter((_, i) => i !== action.index) };
    default:
      return state;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/clinic/avs/form-state.test.ts`
Expected: PASS (6 cases).

- [ ] **Step 5: Commit**

```bash
git add src/modules/clinic/avs/form-state.ts src/modules/clinic/avs/form-state.test.ts
git commit -m "feat(avs): form-state reducer"
```

---

## Task 6: The client form component

**Files:**
- Create: `src/modules/clinic/avs/avs-tool.tsx`

No unit test (client component with browser-only PDF/download APIs); verified via typecheck/build in Task 8 and manual run in Task 9. All pure logic it depends on is already tested.

- [ ] **Step 1: Implement `avs-tool.tsx`**

```tsx
// src/modules/clinic/avs/avs-tool.tsx
"use client";

import { useReducer, useState } from "react";
import { pdf } from "@react-pdf/renderer";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { PageHeader } from "@/platform/ui/page-header";
import { Select } from "@/platform/ui/select";
import { AvsDocument } from "./avs-pdf";
import { buildSummary } from "./build-summary";
import { avsReducer, initialAvsData, type ArrayFieldKey, type StringFieldKey } from "./form-state";
import {
  COMMUNITY_RESOURCES,
  FINANCIAL_RESOURCES,
  FOLLOW_UP,
  LABS,
  VITALS,
  type OptionList,
} from "./strings";
import type { AvsData } from "./types";

function validate(data: AvsData): string[] {
  const errs: string[] = [];
  if (!data.lastName.trim()) errs.push("Last name is required.");
  if (!data.visitDate.trim()) errs.push("Visit date is required.");
  if (!data.primaryReason.trim()) errs.push("Reason for visit is required.");
  return errs;
}

export function AvsTool() {
  const [data, dispatch] = useReducer(avsReducer, initialAvsData);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const setField = (key: StringFieldKey) => (e: { target: { value: string } }) =>
    dispatch({ type: "setField", key, value: e.target.value });

  async function handleGenerate() {
    const errs = validate(data);
    if (errs.length) {
      setErrors(errs);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    setErrors([]);
    setBusy(true);
    try {
      const summary = buildSummary(data, data.preferredLang);
      const blob = await pdf(<AvsDocument summary={summary} />).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `AVS-${data.lastName.trim() || "patient"}-${data.visitDate || "visit"}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setErrors(["Could not generate the PDF. Please try again."]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-16">
      <PageHeader
        title="After Visit Summary"
        description="Fill in the visit details and download a patient handout. Nothing is saved."
        action={
          <Button onClick={handleGenerate} disabled={busy}>
            {busy ? "Generating…" : "Generate PDF"}
          </Button>
        }
      />

      {errors.length > 0 && (
        <Alert tone="error">
          {errors.map((e, i) => (
            <span key={i} className="block">
              {e}
            </span>
          ))}
        </Alert>
      )}

      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-brand">Patient information</h2>
          <label className="flex items-center gap-2 text-xs font-medium text-slate-500">
            Summary language
            <Select
              value={data.preferredLang}
              onChange={(e) => dispatch({ type: "setLang", value: e.target.value as "en" | "es" })}
              className="w-32"
            >
              <option value="en">English</option>
              <option value="es">Español</option>
            </Select>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="First name">
            <Input value={data.firstName} onChange={setField("firstName")} placeholder="Maria" />
          </Field>
          <Field label="Last name *">
            <Input value={data.lastName} onChange={setField("lastName")} placeholder="Garcia" />
          </Field>
          <Field label="Date of birth">
            <Input type="date" value={data.dob} onChange={setField("dob")} />
          </Field>
          <Field label="Visit date *">
            <Input type="date" value={data.visitDate} onChange={setField("visitDate")} />
          </Field>
          <Field label="Provider / clinician">
            <Input value={data.provider} onChange={setField("provider")} placeholder="Dr. Smith" />
          </Field>
          <Field label="Patient ID">
            <Input value={data.patientId} onChange={setField("patientId")} placeholder="HC-000000" />
          </Field>
        </div>
      </Card>

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-brand">Visit details</h2>
        <Field label="Reason for visit *">
          <Input
            value={data.primaryReason}
            onChange={setField("primaryReason")}
            placeholder="Hypertension follow-up"
          />
        </Field>
        <Field label="Diagnoses / conditions" hint="One per line. Printed as typed.">
          <Textarea value={data.diagnoses} onChange={setField("diagnoses")} rows={3} />
        </Field>
        <Field label="Notes for patient" hint="Plain language. Printed as typed.">
          <Textarea value={data.clinicalNotes} onChange={setField("clinicalNotes")} rows={3} />
        </Field>
        <ChipGroup
          label="Vitals reviewed"
          list={VITALS}
          selected={data.vitals}
          onToggle={(value) => dispatch({ type: "toggle", key: "vitals", value })}
        />
      </Card>

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-brand">Medications</h2>
        {data.medications.map((m, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
            <Field label="Medication">
              <Input
                value={m.name}
                onChange={(e) => dispatch({ type: "updateMed", index: i, key: "name", value: e.target.value })}
              />
            </Field>
            <Field label="Dose & instructions">
              <Input
                value={m.dose}
                onChange={(e) => dispatch({ type: "updateMed", index: i, key: "dose", value: e.target.value })}
              />
            </Field>
            <Field label="Lowest-cost source">
              <Input
                value={m.costSource}
                onChange={(e) => dispatch({ type: "updateMed", index: i, key: "costSource", value: e.target.value })}
              />
            </Field>
            <Button variant="ghost" onClick={() => dispatch({ type: "removeMed", index: i })} aria-label="Remove medication">
              ✕
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => dispatch({ type: "addMed" })}>
          + Add medication
        </Button>
      </Card>

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-brand">Next steps</h2>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Follow-up">
            <Select value={data.followUpTimeframe} onChange={setField("followUpTimeframe")}>
              <option value="">Select timeframe</option>
              {FOLLOW_UP.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.en}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Follow-up note">
            <Input value={data.followUpNote} onChange={setField("followUpNote")} placeholder="Blood pressure check" />
          </Field>
        </div>
        <ChipGroup
          label="Labs / tests ordered"
          list={LABS}
          selected={data.labs}
          onToggle={(value) => dispatch({ type: "toggle", key: "labs", value })}
        />
        <div className="space-y-2">
          <span className="text-xs font-medium text-slate-500">Action items</span>
          {data.actionItems.map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={item}
                onChange={(e) => dispatch({ type: "updateActionItem", index: i, value: e.target.value })}
              />
              <Button variant="ghost" onClick={() => dispatch({ type: "removeActionItem", index: i })} aria-label="Remove action item">
                ✕
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => dispatch({ type: "addActionItem" })}>
            + Add action item
          </Button>
        </div>
        <Field label="Lifestyle recommendations" hint="Printed as typed.">
          <Textarea value={data.lifestyle} onChange={setField("lifestyle")} rows={2} />
        </Field>
      </Card>

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-brand">Resources</h2>
        <ChipGroup
          label="Community resources"
          list={COMMUNITY_RESOURCES}
          selected={data.communityResources}
          onToggle={(value) => dispatch({ type: "toggle", key: "communityResources", value })}
        />
        <ChipGroup
          label="Financial resources"
          list={FINANCIAL_RESOURCES}
          selected={data.financialResources}
          onToggle={(value) => dispatch({ type: "toggle", key: "financialResources", value })}
        />
        <Field label="Additional resource">
          <Input
            value={data.customResource}
            onChange={setField("customResource")}
            placeholder="Local YMCA — free membership"
          />
        </Field>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleGenerate} disabled={busy}>
          {busy ? "Generating…" : "Generate PDF"}
        </Button>
      </div>
    </div>
  );
}

function ChipGroup({
  label,
  list,
  selected,
  onToggle,
}: {
  label: string;
  list: OptionList;
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-slate-500">{label}</span>
      <div className="flex flex-wrap gap-2">
        {list.map((o) => {
          const on = selected.includes(o.key);
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => onToggle(o.key)}
              aria-pressed={on}
              className={
                on
                  ? "rounded-lg border border-brand bg-brand/10 px-3 py-1.5 text-sm font-medium text-brand"
                  : "rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 hover:border-brand/40"
              }
            >
              {o.en}
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

> Note: the form UI is English-only by design (spec); the `o.en` labels here are the on-screen control labels. The chosen `preferredLang` only affects the generated PDF via `buildSummary`.

- [ ] **Step 2: Typecheck the new component**

Run: `npm run typecheck`
Expected: no errors. (If `text-brand` / `bg-brand/10` utilities are unrecognized by the linter, they are valid Tailwind v4 brand-token classes already used in the codebase — leave them.)

- [ ] **Step 3: Commit**

```bash
git add src/modules/clinic/avs/avs-tool.tsx
git commit -m "feat(avs): client form with PDF generation and download"
```

---

## Task 7: Route, layout, and navigation entry

**Files:**
- Create: `src/app/clinic/layout.tsx`
- Create: `src/app/clinic/avs/page.tsx`
- Modify: `src/platform/modules/registry.ts`

- [ ] **Step 1: Register the `clinic` module for navigation**

In `src/platform/modules/registry.ts`, add `Stethoscope` to the existing `lucide-react` import, then add this object to the `MODULES` array (place it before the `admin` entry):

```typescript
  {
    id: "clinic",
    title: "Clinic Tools",
    description: "Point-of-care tools for clinical volunteers",
    icon: Stethoscope,
    permissions: [],
    status: "active",
    nav: [{ label: "After Visit Summary", href: "/clinic/avs" }],
  },
```

No `accessPermission` is set, so the module is visible to every signed-in person (matches the spec: any onboarded clinical volunteer).

- [ ] **Step 2: Create the section layout**

```tsx
// src/app/clinic/layout.tsx
import type { ReactNode } from "react";
import { requirePersonSession } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { getModule } from "@/platform/modules/registry";
import { AppShell } from "@/platform/ui/app-shell";
import { ModuleNav } from "@/platform/ui/module-nav";

export default async function ClinicLayout({ children }: { children: ReactNode }) {
  const person = await requirePersonSession();
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
  const mod = getModule("clinic")!;
  return (
    <AppShell userName={person.name} termLabel={activeTerm?.name ?? null} personId={person.personId}>
      <ModuleNav items={mod.nav} />
      <div className="mt-8">{children}</div>
    </AppShell>
  );
}
```

- [ ] **Step 3: Create the page**

```tsx
// src/app/clinic/avs/page.tsx
import { AvsTool } from "@/modules/clinic/avs/avs-tool";

export default function AvsPage() {
  return <AvsTool />;
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Confirms `getModule`, `ModuleNav`, and the new module wiring all resolve.)

- [ ] **Step 5: Commit**

```bash
git add src/app/clinic/layout.tsx src/app/clinic/avs/page.tsx src/platform/modules/registry.ts
git commit -m "feat(avs): /clinic/avs route, layout, and nav entry"
```

---

## Task 8: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm run test`
Expected: all tests pass, including the four new AVS test files.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors in `src/modules/clinic/**` or `src/app/clinic/**`.

- [ ] **Step 4: Production build**

Run: `npm run build`
Expected: build succeeds; `/clinic/avs` appears in the route output.

- [ ] **Step 5: Commit any lint/format fixes (if needed)**

```bash
git add -A
git commit -m "chore(avs): lint and verification fixes"
```

(Skip if the working tree is clean after Steps 1-4.)

---

## Task 9: Manual smoke test

**Files:** none (manual verification)

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Verify the flow**

1. Sign in, then open `http://localhost:3000/clinic/avs`. Confirm the global nav shows "Clinic Tools" and the page renders inside the app shell.
2. Click **Generate PDF** with empty fields — confirm the required-field error alert appears (Last name, Visit date, Reason for visit).
3. Fill last name, visit date, and reason; add a medication, select a few vitals/labs, add an action item and a community resource.
4. With **Summary language = English**, click **Generate PDF** — a file `AVS-<lastname>-<date>.pdf` downloads; open it and confirm headings, the medication, vitals tags, and the disclaimer render.
5. Switch **Summary language = Español**, regenerate — confirm headings and option labels are Spanish while any free-text you typed prints as-is.

- [ ] **Step 3: Confirm no persistence**

Reload `/clinic/avs` — the form is empty (state is in-memory only; nothing was saved). Optionally confirm via the Network tab that generation made no outbound request.

---

## Self-Review Notes

- **Spec coverage:** Ephemeral/no-storage (no DB, client-side PDF — Tasks 4/6/9); dedicated route for clinical volunteers (Task 7, `requirePersonSession`, no permission); generic "Provider" label (Task 6); PDF download (Tasks 4/6); staff picks language per PDF (language Select → `buildSummary`); Approach A translation (Tasks 2/3, static table + free-text passthrough); five trimmed sections (Tasks 3/6); testing of `build-summary`, `strings` parity, and PDF smoke (Tasks 2-4); `@react-pdf/renderer` dependency (Task 1); nav entry point (Task 7). All covered.
- **Type consistency:** `AvsData`, `Medication`, `Lang`, `SummaryItem`/`SummaryBlock`/`LocalizedSummary` defined once in `types.ts`; `AvsAction`/`StringFieldKey`/`ArrayFieldKey` in `form-state.ts`; `OptionList`/`Option` in `strings.ts`. `buildSummary(data, lang)`, `avsReducer(state, action)`, `AvsDocument({ summary })`, `optionLabel(list, key, lang)` signatures match across producer and consumer tasks.
- **No placeholders:** every code step contains complete, runnable content.
```
