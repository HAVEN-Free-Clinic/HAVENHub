import type { TemplateField } from "../../types";

const YES_NO_NA: TemplateField["options"] = [
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
  { label: "N/A", value: "na" },
];

// Verbatim from the live director application form (form pagNLIAaYIfJhuCzU),
// Section 5 "Department Specific Questions". Each question is a required
// LONG_TEXT unless noted otherwise. Departments with no supplement this
// cycle (BVHD, CRAD, FCRL, LCCN, PATS, PBRL) are intentionally omitted; see
// SUPPLEMENT_DEPARTMENTS.DIRECTOR in dept-codes.ts for the recruiting set.
export const supplementQuestions: Record<string, Omit<TemplateField, "order">[]> = {
  EXEC: [
    {
      key: "exec_1",
      label:
        "The ED role requires creating systems that support sustainability and continuity. Describe a time you built or improved a workflow or process. What problem you were addressing, who the key stakeholders were, and what the outcome was.",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "exec_2",
      label:
        "Much of the ED role involves aligning multiple departments around a shared mission. Describe a time you fostered alignment across diverse individuals or groups. What approaches or tools helped you do that?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "exec_3",
      label:
        "The ED sets the tone and culture of the board. What kind of leadership culture would you want to build as Executive Director, and what concrete actions would you take in your first 60 days to model it?",
      type: "LONG_TEXT",
      required: true,
    },
  ],
  JONES: [
    {
      key: "jones_1",
      label:
        "The ED role requires creating systems that support sustainability and continuity. Describe a time you built or improved a workflow or process. What problem you were addressing, who the key stakeholders were, and what the outcome was.",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "jones_2",
      label:
        "Much of the ED role involves aligning multiple departments around a shared mission. Describe a time you fostered alignment across diverse individuals or groups. What approaches or tools helped you do that?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "jones_3",
      label:
        "The ED sets the tone and culture of the board. What kind of leadership culture would you want to build as Executive Director, and what concrete actions would you take in your first 60 days to model it?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "jones_confirm",
      label: "Please confirm you are 4th or 5th year medical student who has completed clinical rotations.",
      type: "CHECKBOX",
      required: true,
    },
  ],
  EDUC: [
    {
      key: "educ_1",
      label:
        "What does effective health education mean to you, and how would you ensure it is accessible and impactful for our patient population?",
      type: "LONG_TEXT",
      required: true,
    },
  ],
  ICDD: [
    {
      key: "icdd_1",
      label: "Why are you interested in serving as an ICDD Director, and why now in your training?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "icdd_2",
      label:
        "What specific suggestions do you have for improving the ICDD, both for patients and for student volunteers? Where do you see the greatest opportunities for impact?",
      type: "LONG_TEXT",
      required: true,
    },
  ],
  MDIC: [
    {
      key: "mdic_1",
      label:
        "Why are you interested in serving as an MDIC Director, and how does this role align with your experience or goals?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "mdic_2",
      label:
        "Where do you see the greatest opportunities for MDIC to grow or improve? Please be specific about what change you think is needed and how you might begin to implement it.",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "mdic_3",
      label:
        "What would be your top three priorities on a clinic day? Please use bullet points and explain each in approximately 50 words.",
      type: "LONG_TEXT",
      required: true,
    },
  ],
  PCAR: [
    {
      key: "pcar_0",
      label: "What kind of Clinical Advisor are you interested in being?",
      type: "SINGLE_SELECT",
      required: true,
      options: [
        { label: "Primary Care Track", value: "primary_care_track" },
        { label: "Specialty Clinic Track", value: "specialty_clinic_track" },
        { label: "Either Position", value: "either_position" },
      ],
    },
    {
      key: "pcar_1",
      label: "What prior HAVEN experience do you have?",
      type: "LONG_TEXT",
      required: true,
      helpText: "Bullet points welcomed.",
    },
    {
      key: "pcar_2",
      label: "What leadership experience do you have?",
      type: "LONG_TEXT",
      required: true,
      helpText: "Bullet points welcomed.",
    },
    {
      key: "pcar_3",
      label: "What ideas do you have to improve the primary care department?",
      type: "LONG_TEXT",
      required: true,
      helpText: "Bullet points welcomed.",
    },
    {
      key: "pcar_4",
      label: "What initiatives could HAVEN consider to expand support for patients?",
      type: "LONG_TEXT",
      required: true,
      helpText: "Bullet points welcomed.",
    },
    {
      key: "pcar_5",
      label: "List here how you have fulfilled the requirements for this position.",
      type: "LONG_TEXT",
      required: true,
      helpText: "Bullet points welcomed.",
    },
    {
      key: "pcar_6",
      label:
        "If you are a 4th or 5th year medical student, would you be interested in receiving elective credit as an SCTP at HAVEN?",
      type: "SINGLE_SELECT",
      required: true,
      options: YES_NO_NA,
    },
  ],
  ITCM: [
    {
      key: "itcm_1",
      label:
        "Why are you interested in serving as an ITCM Director, and how does this role align with your skills or personal/professional goals?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "itcm_2",
      label:
        "What long term initiative(s) or project(s) would you like to implement in your time as an ITCM director? (This doesn't have to be fully fleshed out, just some ideas are fine!)",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "itcm_3",
      label:
        "How would you strengthen collaboration and communication between ITCM and other HAVEN departments? Please share specific strategies or examples of how you have supported cross-team coordination in the past.",
      type: "LONG_TEXT",
      required: true,
    },
  ],
  PHLO: [
    {
      key: "phlo_1",
      label:
        "Why are you interested in serving as a Phlebotomy Director, and how does this role align with your skills or goals?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "phlo_2",
      label:
        "Training and skill-building are major parts of this role. What specific ideas do you have to improve the training experience for volunteers, and how would you begin to implement those ideas?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "phlo_3",
      label:
        "Do you have previous phlebotomy or lab experience? If so, please describe your experience and level of comfort. If not, please describe how you would approach learning these skills.",
      type: "LONG_TEXT",
      required: true,
    },
  ],
  ORHI: [
    {
      key: "orhi_1",
      label:
        "Can you describe a time you led or coordinated a team or project, what challenges did you face, and how did you handle challenges that came up along the way?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "orhi_2",
      label:
        "Have you ever had to make a case or negotiate with senior leadership/outside partners to get approval or resources for a project/goal? How did you approach that, and what was the outcome?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "orhi_3",
      label: "What is your vision for the ORHI department? What are some projects or areas of growth that interest you?",
      type: "LONG_TEXT",
      required: true,
    },
  ],
  QAQI: [
    {
      key: "qaqi_1",
      label:
        "What is one new initiative or process improvement you believe QA/QI should pursue this year? Why this, and what early steps would you take to get it off the ground?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "qaqi_2",
      label:
        "QA/QI Directors lead cross-departmental work and manage multiple projects. How would you describe both your leadership style and your project management approach? Please include one example of how you have led or managed a team?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "qaqi_3",
      label:
        "Please describe any prior experience you have with research, QI, data collection, or analysis. How would you apply those experiences to designing and evaluating QA/QI initiatives at HAVEN?",
      type: "LONG_TEXT",
      required: true,
    },
  ],
  REFF: [
    {
      key: "reff_1",
      label:
        "What do you see as the two biggest issues in HAVEN's referrals system, and what are some ideas you might propose to solve them?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "reff_2",
      label:
        "Referrals often involve coordinating multiple stakeholders (patients, specialty offices, CAs, MDIC, volunteers) sometimes with slow or unclear responses. Describe a time you worked through a bureaucratic or slow-moving process.",
      type: "LONG_TEXT",
      required: true,
    },
  ],
  SOSE: [
    {
      key: "sose_1",
      label:
        "Why do you want to serve as Director of Social Services at HAVEN Free Clinic, and how does this role align with your motivation and goals?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "sose_2",
      label:
        "What experiences have prepared you for this role, and how would they inform your approach to Social Services at HAVEN?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "sose_3",
      label:
        "What are some changes or improvements you believe would meaningfully strengthen the Social Services department, and how would you begin implementing them?",
      type: "LONG_TEXT",
      required: true,
    },
  ],
  SRHD: [
    {
      key: "srhd_1",
      label:
        "Why are you interested in serving as a Reproductive Health Director, and what relevant experiences do you have that would contribute to your success in this role?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "srhd_2",
      label:
        "What prior experiences (clinical or non-clinical) do you bring that will support you in this role (e.g., reproductive health, counseling, procedures, care coordination, teaching)?",
      type: "LONG_TEXT",
      required: true,
    },
  ],
  VADM: [
    {
      key: "vadm_1",
      label:
        "Why are you interested in serving as a Vaccine Director, and what relevant experiences do you have that would contribute to your success in this role?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "vadm_2",
      label:
        "Describe your experience with the Vaccine Department (if applicable) and identify priority areas you'd like to strengthen or grow. If you have not worked with the department before, please share your ideas for its direction.",
      type: "LONG_TEXT",
      required: true,
    },
  ],
  FIND: [
    {
      key: "find_1",
      label: "How would you communicate the impact of HAVEN's work to potential donors?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "find_2",
      label:
        "What types of fundraising strategies do you think are most effective for a student-run organization/clinic, and what is one creative fundraising idea you would bring to HAVEN?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "find_3",
      label: "How do you see the Finance & Development Director contributing to HAVEN's mission?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "find_4",
      label: "What is your background in finance and/or maintaining a budget?",
      type: "LONG_TEXT",
      required: true,
    },
  ],
  INTP: [
    {
      key: "intp_1",
      label:
        "Why are you interested in serving as an Interpretation & Diversity Director, and how does this role align with your goals and experience?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "intp_2",
      label:
        "In your view, what specific values or behaviors are essential for interpreters to ensure patients receive high-quality, patient-centered care?",
      type: "LONG_TEXT",
      required: true,
    },
  ],
  MEDS: [
    {
      key: "meds_1",
      label:
        "Please describe any previous experience working with patient assistance programs, local pharmacies, medication access resources, or medication management system (if any).",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "meds_2",
      label:
        "How would you rate your Excel proficiency on a scale of 1-10? Please also briefly describe how you have used spreadsheets in the past (tracking, inventory, budgeting, etc.).",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "meds_3",
      label:
        "Medication Access Directors must reliably respond to tasks within 24 hours while on shift weeks. Are you willing and able to meet that expectation consistently?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "meds_4",
      label:
        "Please describe a time you resolved a logistical or communication challenge. What was the problem, how did you approach it, and what was the outcome?",
      type: "LONG_TEXT",
      required: true,
    },
  ],
  SRR: [
    {
      key: "srr_1",
      label:
        "Why are you interested in Student Relations, and what relevant experiences do you have that would contribute to your success in this role?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "srr_2",
      label:
        "A core function of this role is building community across departments. What strategies do you use to foster connections, belonging, and collaboration among groups of students? Please provide at least one concrete example.",
      type: "LONG_TEXT",
      required: true,
    },
  ],
};
