// Side-effect-free department catalog. Single source of truth for
// prisma/seed.ts and any test/tooling that needs to know which Department
// codes exist without importing seed.ts (which self-executes on import).
//
// Canonical department names (authoritative). Upserted by code, names updated
// on every run. ITCM's name is intentionally "IT & Compliance Management".
//
// requiresEpicDirector/requiresEpicVolunteer/epicGuidance mirror the
// Department model's Epic-account-requirement columns (see schema.prisma).
// Entries that omit them fall back to the column default of NONE via the
// Prisma create-path (undefined fields are not sent, so the DB default
// applies). Only set on the create path here: prisma/seed.ts's upsert
// `update` clause intentionally only refreshes name/isActive, so a reseed
// never clobbers an admin's edited Epic values.
//
// allowShiftDrop mirrors Department.allowShiftDrop: false makes the department
// swap-only on /schedule. Omitted entries fall back to the column default of
// true. Create-path only, for the same reason as the Epic columns -- a reseed
// must not undo an admin's edit.
type EpicRequirementLiteral = "ALL" | "NONE" | "SOME";

export const DEPARTMENTS: {
  code: string;
  name: string;
  requiresEpicDirector?: EpicRequirementLiteral;
  requiresEpicVolunteer?: EpicRequirementLiteral;
  epicGuidance?: string;
  allowShiftDrop?: boolean;
}[] = [
  { code: "BVHD", name: "Behavioral Health", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL" },
  { code: "CCRH", name: "Care Coordination: Reproductive Health", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL" },
  { code: "CRAD", name: "Community Relations and Development", requiresEpicDirector: "NONE", requiresEpicVolunteer: "NONE" },
  { code: "EDUC", name: "Education", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL" },
  { code: "EXEC", name: "Executive Directors" },
  { code: "FCRL", name: "Faculty Relations", requiresEpicDirector: "NONE", requiresEpicVolunteer: "NONE" },
  { code: "FIND", name: "Finance and Development", requiresEpicDirector: "NONE", requiresEpicVolunteer: "NONE" },
  { code: "FOOD", name: "Food Pharmacy", requiresEpicDirector: "NONE", requiresEpicVolunteer: "NONE" },
  { code: "ICDD", name: "Infectious and Chronic Disease", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL" },
  { code: "INTP", name: "Interpreting", requiresEpicDirector: "NONE", requiresEpicVolunteer: "NONE" },
  { code: "ITCM", name: "IT & Compliance Management", requiresEpicDirector: "NONE", requiresEpicVolunteer: "NONE" },
  { code: "JCTP", name: "Junior Primary Care Team Member", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL", allowShiftDrop: false },
  { code: "JCTS", name: "Junior Reproductive Care Team Member", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL", allowShiftDrop: false },
  { code: "JONES", name: "Jones Fellow" },
  {
    code: "LCCN",
    name: "Longitudinal Care Coordination",
    requiresEpicDirector: "SOME",
    requiresEpicVolunteer: "SOME",
    epicGuidance: "Patient Navigator and Transitions of Care roles need Epic; other roles do not.",
  },
  { code: "MDIC", name: "Medical Debt and Insurance Counseling", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL" },
  { code: "MDLP", name: "Medical Debt and Legal Partnership", requiresEpicDirector: "NONE", requiresEpicVolunteer: "NONE" },
  { code: "MEDS", name: "Medication Access", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL" },
  { code: "ORHL", name: "Oral Health", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL" },
  { code: "PATS", name: "Patient Services", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL" },
  { code: "PBRL", name: "Public Relations", requiresEpicDirector: "NONE", requiresEpicVolunteer: "NONE" },
  { code: "PCAR", name: "Primary Care Clinical Advisors", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL" },
  { code: "PHLO", name: "Phlebotomy", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL" },
  { code: "PNLC", name: "Patient Navigation: Longitudinal Care", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL" },
  { code: "PNTC", name: "Patient Navigation: Transfer of Care", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL" },
  {
    code: "QAQI",
    name: "Quality Assurance and Quality Improvement",
    requiresEpicDirector: "SOME",
    requiresEpicVolunteer: "SOME",
    epicGuidance: "Only if indicated by your directors.",
  },
  { code: "REFF", name: "Referrals", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL" },
  { code: "SCTL", name: "Senior Longitudinal Care Clinical Team Member", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL", allowShiftDrop: false },
  { code: "SCTP", name: "Senior Primary Care Clinical Team Member", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL", allowShiftDrop: false },
  { code: "SCTS", name: "Senior Reproductive Care Clinical Team Member", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL", allowShiftDrop: false },
  { code: "SOSE", name: "Social Services", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL" },
  { code: "SRHD", name: "Sexual and Reproductive Health", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL" },
  { code: "SRR", name: "Student Recruitment and Relations", requiresEpicDirector: "NONE", requiresEpicVolunteer: "NONE" },
  { code: "TBAD", name: "Translational Bridge and Advocacy" },
  { code: "VADC", name: "Vaccine Management", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL" },
  { code: "VADM", name: "Vaccine Administration", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL" },
];
