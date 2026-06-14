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
