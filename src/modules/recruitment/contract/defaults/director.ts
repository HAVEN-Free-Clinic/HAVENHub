import type { ContractLayout } from "../layout";
import { HIPAA_INSTRUCTIONS, EPIC_PREAMBLE, EPIC_ACCESS_GUIDANCE, DATA_PRIVACY_STATEMENT, HAVEN_AGREEMENT_SIGNATURE } from "./shared";
import { DEPARTMENT_RESPONSIBILITY_BLOCKS } from "./departments";

export const DIRECTOR_LAYOUT: ContractLayout = {
  blocks: [
    { kind: "section", id: "sec_intro", title: "Director Contract",
      body: `Congratulations and welcome to {{orgName}}. We are excited to have you join our team and look forward to the impact you will make as a Director. This onboarding form ensures we have the necessary information to set up your access, maintain data privacy, and support you in your role at the clinic.

Please complete this form to confirm your participation in the {{orgName}} Board of Directors. Failure to sign and submit the contract within the required timeframe may result in disqualification from the position.

**DATA PRIVACY:** Protecting patient information is of utmost importance within {{orgName}}. Failure to submit this form will result in you being unable to continue as a volunteer for this term and removal from Microsoft Teams as necessary. Both new and returning volunteers must submit this form within 48 hours of their acceptance notification.

**EMR ACCESS (if needed):** ${EPIC_PREAMBLE}` },

    { kind: "section", id: "sec_demographics", title: "Demographic Information", body: "" },
    { kind: "system_field", systemKey: "name" },
    { kind: "system_field", systemKey: "email" },
    { kind: "system_field", systemKey: "netId" },
    { kind: "system_field", systemKey: "phone" },
    { kind: "system_field", systemKey: "pronouns" },
    { kind: "system_field", systemKey: "dob" },
    { kind: "system_field", systemKey: "yaleAffiliation" },
    { kind: "system_field", systemKey: "gradYear" },
    { kind: "system_field", systemKey: "staffTitle",
      visibleWhen: { field: "yaleAffiliation", op: "is", value: "staff" } },
    { kind: "system_field", systemKey: "dietary" },

    { kind: "section", id: "sec_contracts", title: "Director Contracts", body: "" },
    { kind: "agreement", id: "board_responsibilities", title: "Board Responsibilities",
      confirmKind: "checkbox", signatureLabel: "I confirm these responsibilities",
      body: `- Attend and actively participate in all Board meetings, which occur every 2 weeks.
- Take an active role in at least one of three subcommittees (Quality Assurance, Community Relations and Engagement, Sustainability and Development), including attending all subcommittee meetings which occur every 2 weeks.
- Participate in monthly department meetings with an ED.
- Manage a consistent and effective communication system between your department's co-directors, if applicable.
- Respond to {{orgName}} related emails and requests in a professional and timely fashion.
- Monitor and evaluate department-specific and clinic-wide performance. Develop and execute quarterly quality assurance and quality improvement goals that reflect vision and initiative for your department.
- Recruit, select, schedule, record certification of, and train volunteers for your department, if applicable.
- Engage in other Board-wide undertakings, such as strategic planning sessions and fundraisers.
- Raise a minimum of $300 for the {{orgName}} 5K which occurs every Fall. Foster and maintain lasting community partnerships to inform our work.
- Be supportive, collaborative and flexible.
- Take on other responsibilities as they arise.` },
    { kind: "agreement", id: "strike_policy", title: "Active Engagement and Attendance",
      confirmKind: "checkbox", signatureLabel: "I confirm this policy",
      body: `Directors uphold the standard of professionalism to ensure the highest quality of care to our patients, the education and training of our student volunteers, and the administration and financial stability of our operations. We expect transparent and proactive communication. While there are numerous processes and resources to support you, Directors and volunteers will be held accountable if unable to fulfill commitments.

**Strike Policy**

- 2 unexcused tardies = 1 strike
- 1 unexcused absence for clinic = 1 strike
- 2 unexcused absences to board meetings = 1 strike
- 3 unexcused absences to subcommittee meetings = 1 strike
- HIPAA violation = immediate grounds for termination at the discretion of {{orgName}} Leadership
- Disrespect towards colleagues, volunteers or patients = 1 strike
- 2 instances of untimely communication with EDs, directors or volunteers = 1 strike
- Failure to perform duties affecting clinic or department workflow = 1 strike

A tardy is defined as late to the extent that it impacts patient care or the workflow of a department.

**3 strikes are grounds for termination unless a different course of action is determined by the EDs after a meeting with the {{orgName}} Board member.**` },

    ...DEPARTMENT_RESPONSIBILITY_BLOCKS,

    { kind: "custom_question", key: "second_department",
      label: "Do you plan on volunteering with another department during your term?",
      helpText: "You can only volunteer in a second patient-facing department if you have a non-patient-facing board position.",
      type: "SINGLE_SELECT", required: true,
      options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] },
    { kind: "custom_question", key: "second_department_name",
      label: "If yes, what department will you be volunteering with?",
      type: "DEPARTMENT_CHOICE", required: true,
      visibleWhen: { field: "second_department", op: "is", value: "yes" } },

    { kind: "section", id: "sec_hipaa", title: "HIPAA Training", body: HIPAA_INSTRUCTIONS },
    { kind: "system_field", systemKey: "hipaa" },

    { kind: "agreement", id: "data_privacy", title: "{{orgName}} Data Privacy Statement",
      confirmKind: "signature", signatureLabel: "type your full name",
      body: DATA_PRIVACY_STATEMENT },
    { kind: "agreement", id: "haven_agreement", title: "{{orgName}} Agreement Signature",
      confirmKind: "signature", signatureLabel: "type your full name",
      body: HAVEN_AGREEMENT_SIGNATURE },

    // The Epic section hides for a department that never uses Epic when the
    // applicant has no id on file (epicSection derived in contract/visibility.ts).
    { kind: "section", id: "sec_epic", title: "Epic Access", body: EPIC_ACCESS_GUIDANCE,
      visibleWhen: { field: "epicSection", op: "is", value: "show" } },
    { kind: "custom_question", key: "epic_needed_self",
      label: "Is Epic access required for your role at {{orgName}}?",
      type: "SINGLE_SELECT", required: true,
      options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
      visibleWhen: { field: "epicAsk", op: "is", value: "yes" } },
    { kind: "system_field", systemKey: "epic",
      visibleWhen: { field: "epicSection", op: "is", value: "show" } },

    { kind: "agreement", id: "training", title: "Director Training",
      confirmKind: "checkbox", signatureLabel: "I will be attending",
      body: `Director training will be in person and mandatory for everyone. I acknowledge that I can attend the director training on {{trainingDate}}{{trainingLocation}}, or will notify the EDs and SR&R as soon as possible.` },
    { kind: "agreement", id: "final_acknowledgement", title: "Board Director Acknowledgement",
      confirmKind: "signature", signatureLabel: "type your full name",
      body: `By typing your full name below, you fully acknowledge and commit to the responsibilities as a Board Director at {{orgName}}.` },
  ],
};
