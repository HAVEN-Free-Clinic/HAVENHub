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
