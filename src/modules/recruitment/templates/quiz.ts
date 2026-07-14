import type { Track } from "@prisma/client";
import type { TemplateSection } from "./types";

// Verbatim from the live Airtable training-quiz form (makeup form
// pagzNM5jQ2SKmbVyI), 15 questions. No answer key ships with the default
// (decision 5); directors set correctValue per cycle after publishing.
const QUESTIONS: Array<{ key: string; label: string; options: string[] }> = [
  {
    key: "quiz_population",
    label: "What population does HAVEN primarily serve?",
    options: [
      "Yale students",
      "Insured adults with primary care providers",
      "Uninsured adults in Greater New Haven without a primary care provider",
      "Pediatric patients only",
    ],
  },
  {
    key: "quiz_mission",
    label: "Which of the following is part of HAVEN's mission?",
    options: [
      "Providing safe, high-quality primary care, wellness education, and social services",
      "Replacing emergency departments",
      "Serving only patients with private insurance",
      "Providing inpatient hospital care",
    ],
  },
  {
    key: "quiz_volunteers_importance",
    label: "Why are volunteers important to HAVEN's mission?",
    options: [
      "HAVEN relies on student, faculty, and community volunteers to provide patient care and services",
      "Volunteers only observe and do not affect patient care",
      "Volunteers mainly help with fundraising",
      "Volunteers are optional for clinic operations",
    ],
  },
  {
    key: "quiz_language_record",
    label: "Why is language in the medical record important?",
    options: [
      "Patients may access their notes",
      "Documentation can affect patient privacy and trust",
      "Information in the chart may be difficult to remove",
      "All of the above",
    ],
  },
  {
    key: "quiz_epic_phrase",
    label: "Which phrase should NOT be used in Epic documentation?",
    options: [
      '"Patient reports difficulty accessing services."',
      '"Patient has financial barriers."',
      '"Illegal immigrant."',
      '"Patient was referred to Social Services."',
    ],
  },
  {
    key: "quiz_sensitive_info",
    label: "What should volunteers do if unsure whether to include sensitive information in a note?",
    options: [
      "Document it anyway",
      "Ask a CA, ED, or appropriate supervisor before documenting",
      "Ask the patient's family member",
      "Leave it out and tell no one",
    ],
  },
  {
    key: "quiz_hipaa_protects",
    label: "What is HIPAA designed to protect?",
    options: ["Volunteer schedules", "Sensitive patient information", "Parking access", "Clinic maps"],
  },
  {
    key: "quiz_patient_identifier",
    label: "Which of the following is a patient identifier that should not be shared publicly?",
    options: ["Name", "Date of birth", "Medical record number", "All of the above"],
  },
  {
    key: "quiz_also_ask",
    label: "Even if HIPAA-compliant, volunteers should also ask:",
    options: [
      "Does this protect the patient's privacy?",
      "Would this be appropriate language to use in the chart?",
      "Is this information necessary to share?",
      "All of the above",
    ],
  },
  {
    key: "quiz_avoid_action",
    label: "Which action should volunteers avoid?",
    options: [
      "Looking at charts of patients not assigned to them",
      "Using Microsoft Teams for HAVEN work",
      "Communicating patient information in designated secured methods",
      "Locking computers when stepping away",
    ],
  },
  {
    key: "quiz_clinic_location",
    label: "Where is HAVEN clinic located?",
    options: [
      "Yale New Haven Hospital Emergency Department",
      "Yale Physicians Building, 800 Howard Avenue",
      "Yale Health",
      "Fair Haven Community Health Care",
    ],
  },
  {
    key: "quiz_contact_scheduling",
    label: "Who should volunteers contact for scheduling, training, or roster updates?",
    options: ["Student Recruitment", "Medical-Legal Partnership", "A patient navigator", "A faculty attending"],
  },
  {
    key: "quiz_contact_it",
    label:
      "Who should volunteers contact for Microsoft Teams access issues, Epic access issues, or technical problems related to HAVEN systems?",
    options: ["Department directors", "Student Recruitment", "HAVEN IT", "Executive Directors"],
  },
  {
    key: "quiz_ipv_disclosure",
    label:
      "During your visit/phone call, your patient discloses she does not feel safe in her relationship. Which of the following is the best next step in management?",
    options: [
      "Provide reassurance",
      "Notify your department director immediately",
      "Conduct an IPV screening yourself",
      "Ignore the statement as you have to finish your visit/phone call on time",
    ],
  },
  {
    key: "quiz_access_check_timing",
    label: "When should I check my Epic/Teams access before my shift?",
    options: ["The day of clinic", "The Friday before clinic", "The Monday before clinic"],
  },
];

/** Stable, deterministic machine value for an option's exact text. */
function slugifyOption(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/["'.]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug || "option";
}

export function getQuizTemplate(_track: Track): TemplateSection[] {
  return [
    {
      title: "Training knowledge check",
      order: 0,
      appliesTo: "BOTH",
      departmentCode: null,
      purpose: "QUIZ",
      fields: QUESTIONS.map((q, i) => ({
        key: q.key,
        label: q.label,
        type: "SINGLE_SELECT",
        required: true,
        options: q.options.map((o) => ({ label: o, value: slugifyOption(o) })),
        order: i,
      })),
    },
  ];
}
