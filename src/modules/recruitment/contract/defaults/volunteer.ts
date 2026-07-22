import type { ContractLayout } from "../layout";
import { HIPAA_INSTRUCTIONS, EPIC_ACCESS_GUIDANCE, HAVEN_AGREEMENT_SIGNATURE } from "./shared";

export const VOLUNTEER_LAYOUT: ContractLayout = {
  blocks: [
    { kind: "section", id: "sec_basic", title: "Basic Information",
      body: "Welcome to {{orgName}}, we are so excited to have you." },
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

    { kind: "section", id: "sec_hipaa", title: "HIPAA Compliance", body: HIPAA_INSTRUCTIONS },
    { kind: "system_field", systemKey: "hipaa" },

    // The Epic section hides for a department that never uses Epic when the
    // applicant has no id on file (epicSection derived in contract/visibility.ts).
    { kind: "section", id: "sec_epic", title: "Epic Access", body: EPIC_ACCESS_GUIDANCE,
      visibleWhen: { field: "epicSection", op: "is", value: "show" } },
    { kind: "custom_question", key: "epic_needed_self",
      label: "Is Epic access required for your role at {{orgName}}?",
      type: "SINGLE_SELECT", required: true,
      options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
      visibleWhen: { field: "epicAsk", op: "is", value: "yes" } },
    // The epic block itself confirms a stored id or collects one; hidden with
    // the section when Epic is not needed and none is on file.
    { kind: "system_field", systemKey: "epic",
      visibleWhen: { field: "epicSection", op: "is", value: "show" } },

    { kind: "section", id: "sec_contract", title: "Volunteer Contract", body: "" },
    { kind: "agreement", id: "agreement", title: "Volunteer Agreement", confirmKind: "initials",
      signatureLabel: "initial below",
      body: `By submitting this contract, I agree to be a volunteer at {{orgName}} during my assigned shifts. I understand that {{orgName}} serves an uninsured patient population for which the clinic functions as their main, if not only, source of medical care. Further, I understand that my role as a volunteer is crucial and integral in providing patients with vital health care services, and I am fully committed to fulfilling my responsibilities to this population as a volunteer. If I do not fulfill my volunteer commitments, I understand that the {{orgName}} directors have the discretion to remove me from my role as a volunteer.` },
    { kind: "agreement", id: "professionalism", title: "Volunteer Attendance and Professionalism Policies",
      confirmKind: "initials", signatureLabel: "initial below",
      body: `**Attendance Policy (Strike Policy)**

Volunteers absent from clinic on their scheduled day who do not find replacements will receive a first strike. If a volunteer receives two strikes in one term, then they may not be allowed to continue volunteering in that department for the remainder of that term or the next term at the discretion of the department's directors. Volunteers who receive a strike will be notified by email from a department director with the reason and date. When a volunteer receives two strikes, they will be notified by the Executive Director and will be ineligible to volunteer at {{orgName}} for the following semester. Failure to complete any necessary trainings for the department is equivalent to two strikes and will result in the same consequences.

**Professionalism**

Volunteers may be dismissed for the current semester if they fail to complete their volunteer commitments. This includes, but is not limited to, failure to attend training and complete onboarding within stated deadlines, failure to schedule shifts, and failure to respond to Directors' communications regarding volunteer duties and expectations within reasonable time to address a patient or clinic need. HIPAA violations will be reported in accordance with HIPAA policy as well as handled internally per the discretion of the Executive Directors and Department Directors, and may result in a strike and required re-training or in dismissal.

**Dismissal**

Volunteers may be dismissed by the Executive Directors in accordance with either the Strike Policy or the Professionalism Policy.` },
    { kind: "agreement", id: "commitment", title: "Commitment to the Entirety of the Semester",
      confirmKind: "initials", signatureLabel: "initial below",
      body: `This volunteer contract is binding for the semester. Volunteers are expected to complete the minimum number of shifts required by their department. Early departure in the semester without an extenuating circumstance or written agreement prior to accepting the position will make the student ineligible to volunteer the following {{orgName}} term or semester.` },
    { kind: "agreement", id: "training", title: "Training Acknowledgement",
      confirmKind: "initials", signatureLabel: "initial below",
      body: `I acknowledge that I can attend the training on {{trainingDate}}{{trainingLocation}} or will otherwise inform my directors.` },
    { kind: "agreement", id: "haven_agreement", title: "{{orgName}} Agreement Signature",
      confirmKind: "signature", signatureLabel: "type your full name",
      body: HAVEN_AGREEMENT_SIGNATURE },
  ],
};
