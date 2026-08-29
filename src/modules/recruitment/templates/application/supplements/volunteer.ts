import type { TemplateField } from "../../types";

const YES_NO_NA: TemplateField["options"] = [
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
  { label: "N/A", value: "na" },
];

const YES_NO: TemplateField["options"] = [
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
];

const SRHD_PROGRAM_YEAR: TemplateField["options"] = [
  { label: "1st year YSN GEPN (1 year accelerated RN program)", value: "ysn_gepn_1st_year" },
  { label: "1st year in YSN MSN program", value: "ysn_msn_1st_year" },
  { label: "2nd year in YSN MSN program", value: "ysn_msn_2nd_year" },
  { label: "1st year - YSM - PA or MD program", value: "ysm_pa_md_1st_year" },
  { label: "2nd year - YSM - PA or MD program", value: "ysm_pa_md_2nd_year" },
  { label: "3rd year - YSM - PA or MD program", value: "ysm_pa_md_3rd_year" },
  { label: "4th year - MD program", value: "ysm_md_4th_year" },
  { label: "5th year - YSM Research/Masters year", value: "ysm_research_masters_5th_year" },
  { label: "Other", value: "other" },
];

/** The four SRHD questions, keyed per department to keep FormField keys globally unique within a cycle. */
function rhdQuestions(prefix: string): Omit<TemplateField, "order">[] {
  return [
    {
      key: `${prefix}_1`,
      label: "What prior experiences do you have in the OB/GYN field?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: `${prefix}_2`,
      label: "What year are you in your program?",
      type: "SINGLE_SELECT",
      required: true,
      options: SRHD_PROGRAM_YEAR,
    },
    {
      key: `${prefix}_3`,
      label: "If you are a student in a Yale School of Nursing program, will you have your RN by the time you begin volunteering?",
      type: "SINGLE_SELECT",
      required: true,
      options: YES_NO_NA,
    },
    {
      key: `${prefix}_addition`,
      label:
        "If you are applying for RHD SCTM, have you completed your graduate health professional school (YSM/YSN) OB/GYN clinical rotations?",
      type: "SINGLE_SELECT",
      required: true,
      options: YES_NO_NA,
    },
  ];
}

/** The four SCTP/JCTP primary-care clinical supplement questions, keyed per department. */
function primaryCareQuestions(prefix: string): Omit<TemplateField, "order">[] {
  return [
    {
      key: `${prefix}_1`,
      label: "Please tell us your program (MD, PA, NP, etc.) and year.",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: `${prefix}_2`,
      label:
        "Please describe your specific interest in volunteering as an SCTP/JCTP, including any significant previous clinical experiences within or outside of HAVEN.",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: `${prefix}_3`,
      label:
        "Please describe your other academic & clinical commitments this summer; can you volunteer for at least 4 shifts with us this term?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: `${prefix}_4`,
      label: "Do you have interest in being an SCTL (longitudinal SCTP) who manages their own panel of 6-8 patients?",
      type: "LONG_TEXT",
      required: true,
    },
  ];
}

// Verbatim from the live volunteer application form (form pagpJAAocmlcgKM6G).
// Departments with no supplement this cycle (BVHD, FOOD, INTP, FIND, PNLC,
// PNTC, MEDS, REFF, SCTL, SOSE, ICDD, VADM, VADC) are intentionally omitted;
// see SUPPLEMENT_DEPARTMENTS.VOLUNTEER in dept-codes.ts for the recruiting set.
export const supplementQuestions: Record<string, Omit<TemplateField, "order">[]> = {
  // RHD (sexual/reproductive-health) supplement, shared across CCRH/JCTS/SCTS.
  // CCRH only shows the "Addition" question; JCTS and SCTS show all four.
  CCRH: [rhdQuestions("ccrh")[3]],
  JCTS: rhdQuestions("jcts"),
  SCTS: rhdQuestions("scts"),

  EDUC: [
    {
      key: "educ_1",
      label:
        "If not included in your cover letter, please use this space to share, why you would like to join the Education Department?",
      type: "LONG_TEXT",
      required: false,
    },
    {
      key: "educ_2",
      label: "Can you elaborate more on your relevant experience?",
      type: "LONG_TEXT",
      required: false,
    },
  ],

  // Primary-care clinical supplement, shared across JCTP/SCTP (label "SCTP / JCTP / SCTL Supplement").
  JCTP: primaryCareQuestions("jctp"),
  SCTP: primaryCareQuestions("sctp"),

  PHLO: [
    {
      key: "phlo_1",
      label: "If not included in your cover letter, why do you want to volunteer with the Phlebotomy Department?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "phlo_2",
      label: "Please describe any previous phlebotomy experience.",
      type: "LONG_TEXT",
      required: true,
    },
  ],

  MDIC: [
    {
      key: "mdic_1",
      label:
        "What do you think is important when communicating with patients about sensitive topics? Please keep your answer to approximately 100 words.",
      type: "LONG_TEXT",
      required: true,
    },
  ],

  ORHL: [
    {
      key: "orhl_1",
      label:
        "Please consider the following: At its core, what creates trust between HAVEN and our patients? What is the significance of oral health? Please indicate what position you would be interested in.",
      type: "LONG_TEXT",
      required: true,
    },
  ],

  PATS: [
    {
      key: "pats_1",
      label:
        "Patient Services requires a lot of communication and collaboration. How do you plan to integrate patients' needs into your weekly schedule and communicate with your director and team members?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "pats_2",
      label:
        "Taking on a role with Patient Services requires consistent face-to-face interactions with patients. We are typically the first and last people patients see during the clinic day. How do you think you will deal with the needs/demands of this patient-facing role and ensure patients feel safe and welcome at our clinic?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "pats_3",
      label:
        "Patient Services requires extensive interdepartmental collaboration to meet our patients' needs. Tell us about a time when you worked alongside another team or department to achieve a common goal. How did you make the most of each group's strengths to accomplish your goal?",
      type: "LONG_TEXT",
      required: true,
    },
  ],

  QAQI: [
    {
      key: "qaqi_1",
      label: "Please describe any prior experience you have with research, QA/QI, data collection, or analysis.",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "qaqi_2",
      label: "Do you have experience with any programming languages? If so, which ones?",
      type: "LONG_TEXT",
      required: true,
    },
    {
      key: "qaqi_3",
      label:
        "Considering other academic/professional/clinical commitments you may have this summer, please confirm that you can contribute at least a few hours/week for QA/QI project work and meetings.",
      type: "SINGLE_SELECT",
      required: true,
      options: YES_NO,
    },
  ],
};
