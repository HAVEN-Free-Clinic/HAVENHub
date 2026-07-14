import type { Track } from "@prisma/client";
import type { TemplateSection } from "./types";

// Question stems verbatim from the Airtable makeup-training form. Options are
// authored in Task 8 (from the live form); no correctValue by decision.
const QUESTIONS: Array<{ key: string; label: string; options: string[] }> = [
  { key: "quiz_population", label: "What population does HAVEN primarily serve?", options: ["Uninsured patients", "Insured patients", "Yale students only", "Hospital inpatients"] },
  { key: "quiz_mission", label: "Which of the following is part of HAVEN's mission?", options: ["Free, student-run care for the uninsured", "For-profit specialty care", "Inpatient surgery", "Insurance sales"] },
  { key: "quiz_volunteers", label: "Why are volunteers important to HAVEN's mission?", options: ["They deliver the clinic's care", "They fund the clinic", "They own the building", "They are not important"] },
  { key: "quiz_language_record", label: "Why is language in the medical record important?", options: ["It affects patient care and dignity", "It has no effect", "Only for billing", "Only for research"] },
  { key: "quiz_epic_phrase", label: "Which phrase should NOT be used in Epic documentation?", options: ["Objective clinical language", "Judgmental or stigmatizing language", "Standard abbreviations", "Vital signs"] },
  { key: "quiz_sensitive_note", label: "What should volunteers do if unsure whether to include sensitive information in a note?", options: ["Ask a director or supervising provider", "Include everything", "Guess", "Leave the note blank"] },
  { key: "quiz_identifier", label: "Which of the following is a patient identifier that should not be shared publicly?", options: ["Full name or MRN", "The weather", "Clinic hours", "The building address"] },
  { key: "quiz_also_ask", label: "Even if information is HIPAA-compliant, volunteers should also ask:", options: ["Is sharing this necessary and respectful?", "Can I post it online?", "Who else wants to know?", "Nothing further"] },
  { key: "quiz_avoid_action", label: "Which action should volunteers avoid?", options: ["Sharing patient details outside of care", "Documenting accurately", "Asking for help", "Following up on referrals"] },
  { key: "quiz_location", label: "Where is HAVEN clinic located?", options: ["Fair Haven, New Haven", "New York", "Hartford", "Boston"] },
  { key: "quiz_contact_scheduling", label: "Who should volunteers contact for scheduling, training, or roster updates?", options: ["Student Recruitment and Relations (SR&R)", "The hospital CEO", "No one", "A patient"] },
  { key: "quiz_contact_it", label: "Who should volunteers contact for Microsoft Teams, Epic access, or technical issues?", options: ["IT & Compliance Management (ITCM)", "The pharmacy", "A patient", "No one"] },
  { key: "quiz_ipv", label: "During a visit, a patient discloses she does not feel safe in her relationship. What is the best next step?", options: ["Follow HAVEN's safety protocol and involve a supervising provider", "Ignore it", "Post about it", "End the visit immediately"] },
  { key: "quiz_access_check", label: "When should you check your Epic/Teams access before your shift?", options: ["Well before the shift, not the day of", "During the shift", "After the shift", "Never"] },
];

export function getQuizTemplate(_track: Track): TemplateSection[] {
  return [{
    title: "Training knowledge check",
    order: 0,
    appliesTo: "BOTH",
    departmentCode: null,
    purpose: "QUIZ",
    fields: QUESTIONS.map((q, i) => ({
      key: q.key, label: q.label, type: "SINGLE_SELECT", required: true,
      options: q.options.map((o) => ({ label: o, value: o })), order: i,
    })),
  }];
}
