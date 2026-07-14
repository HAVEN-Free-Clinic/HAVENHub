// Side-effect-free department catalog. Single source of truth for
// prisma/seed.ts and any test/tooling that needs to know which Department
// codes exist without importing seed.ts (which self-executes on import).
//
// Canonical department names (authoritative). Upserted by code, names updated
// on every run. ITCM's name is intentionally "IT & Compliance Management".
export const DEPARTMENTS: { code: string; name: string }[] = [
  { code: "BVHD", name: "Behavioral Health" },
  { code: "CCRH", name: "Care Coordination: Reproductive Health" },
  { code: "CRAD", name: "Community Relations and Development" },
  { code: "EDUC", name: "Education" },
  { code: "EXEC", name: "Executive Directors" },
  { code: "FCRL", name: "Faculty Relations" },
  { code: "FIND", name: "Finance and Development" },
  { code: "FOOD", name: "Food Pharmacy" },
  { code: "ICDD", name: "Infectious and Chronic Disease" },
  { code: "INTP", name: "Interpreting" },
  { code: "ITCM", name: "IT & Compliance Management" },
  { code: "JCTP", name: "Junior Primary Care Team Member" },
  { code: "JCTS", name: "Junior Reproductive Care Team Member" },
  { code: "JONES", name: "Jones Fellows" },
  { code: "LABR", name: "Laboratory" },
  { code: "LCCN", name: "Longitudinal Care Coordination" },
  { code: "MDIC", name: "Medical Debt and Insurance Counseling" },
  { code: "MDLP", name: "Medical Debt and Legal Partnership" },
  { code: "ORHI", name: "Oral Health Initiative" },
  { code: "PATS", name: "Patient Services" },
  { code: "PBRL", name: "Public Relations" },
  { code: "PCAR", name: "Primary Care Clinical Advisors" },
  { code: "PHAM", name: "Pharmacy" },
  { code: "PNLC", name: "Patient Navigation: Longitudinal Care" },
  { code: "PNTC", name: "Patient Navigation: Transfer of Care" },
  { code: "QAQI", name: "Quality Assurance and Quality Improvement" },
  { code: "REFF", name: "Referrals" },
  { code: "SCTL", name: "Senior Longitudinal Care Team Member" },
  { code: "SCTP", name: "Senior Primary Care Clinical Team Member" },
  { code: "SCTS", name: "Senior Reproductive Care Clinical Team Member" },
  { code: "SOSE", name: "Social Services" },
  { code: "SRHD", name: "Sexual and Reproductive Health" },
  { code: "SRR", name: "Student Recruitment and Relations" },
  { code: "TBAD", name: "Translational Bridge and Advocacy" },
  { code: "VADC", name: "Vaccine Management" },
  { code: "VADM", name: "Vaccine Administration" },
];
