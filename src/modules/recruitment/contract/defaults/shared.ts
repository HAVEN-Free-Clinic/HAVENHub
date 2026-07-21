// Prose shared across the volunteer and director default contract layouts.
// Authored in the Task 1 markdown subset (see ../prose.tsx): blank-line
// paragraphs, **bold**, `- ` bullets, and [label](https://url) / bare
// https:// links only. No headings, italics, numbered lists, or nested
// bullets, since the renderer does not support them. Transcribed from the
// Airtable form.

export const HIPAA_INSTRUCTIONS = `- **HIPAA Training Instructions:** Go to [hipaa.yale.edu/training/training-modules](https://hipaa.yale.edu/training/training-modules) to complete the "Foundational HIPAA Privacy and Security Training" course and save the certificate of completion.
- There is also an "Annual HIPAA Security Attestation and HIPAA Refresher" for anyone who completed the primary course over a year ago.
- If you are not currently a Yale student, please review and sign off on the clinician's training and upload that instead of a certificate.

Please upload your HIPAA Training certificate as a PDF called "HIPAA Certificate FirstName LastName.pdf". Do not take a picture of your results; download the file itself. Quiz results are not acceptable.

To print your certificate, log into Yale Workday and navigate from "Menu" to "Learning" to "Print Learning Certificate - Yale", then enter the date of completion. There is no need to select anything in the "Learning Content Title" field. The certificate PDF will appear in your notification pane.

**This must be valid within eight months for it to be acceptable.**`;

export const EPIC_PREAMBLE = `{{orgName}} is given access to the Epic EMR since we interface with the YNHH system. Some volunteers receive Epic access directly through {{orgName}} and others, such as clinical students, receive it through their program. This information is kept confidential and is only accessible to the current IT and Communications Director, used only for Epic account-obtaining purposes for YNHH.

Directions about Epic updates will follow in the days after you complete this form.`;

export const DATA_PRIVACY_STATEMENT = `**Introduction**

HAVEN Free Clinic is a volunteer-run free clinic that services uninsured patients living in the greater New Haven area. As volunteers, we have the privilege of serving patients who are particularly vulnerable in the health care system. In that process, we must balance the need to collect data on our patients to improve our operations with the risks associated with accessing, storing, and sharing patient data.

**Data Privacy and Safety Measures**

In order to access medical records on HAVEN's patients, every volunteer completes the Yale HIPAA training through the HIPAA privacy office before gaining access to HAVEN's platforms. By signing this form, you affirm that:

- As a volunteer, you have completed or will complete the Yale HIPAA training and annual refresher as required through Yale. Volunteers are responsible for tracking when their certification expires. Any questions may be directed to the QA/QI directors and IT director.
- As a director, you are responsible for ensuring that all your volunteers are up to date on their HIPAA training at the start of each term, regardless of whether they are new or returning.

HAVEN operates across several different platforms based on each department's workflow. By signing this form, you affirm that you will use only HIPAA-compliant platforms to discuss clinic or patient-related information.

- HIPAA-compliant platforms include Epic, Yale Secure Box, Microsoft Teams, and Yale Outlook Email.
- Non-HIPAA-compliant platforms include Yale Box, the native Google suite, any other email modality, Slack (the free base version), downloading any documents from HIPAA-compliant platforms onto personal devices, GroupMe, and text messaging.

By signing this form, you affirm that you will follow best practices when sharing patient information.

- Please limit discussion of patients to private areas. Avoid discussing patient information in hallways, elevators, and around others who are not directly associated with that patient's care. Refrain from discussing any patients with anyone outside of the clinic.
- Please access Epic in private areas on a private network. Avoid accessing Epic in public areas such as coffee shops where non-clinic personnel can view your screen or access information over a public wifi network.

By signing this form, you affirm that any projects you are involved in that require IRB approval or IRB exemption will be obtained prior to starting the project.

- As a volunteer, you must double-check whether any projects you are involved in require IRB approval or exemption. Please review the [Yale IRB policies](https://your.yale.edu/research-support/human-research/policies-procedures-guidance-and-checklists) to determine which applies.
- As a director, you are responsible for determining whether any data collected in your department requires IRB approval or exemption.

If a study requires IRB approval or exemption, directors must ensure that the study is submitted to HAVEN Data Centralization via the QA/QI Directors, that executive directors are aware of the study, and that the department director works with the executive directors and QA/QI directors to identify a faculty advisor.`;

export const HAVEN_AGREEMENT_SIGNATURE = `By signing this form, you are agreeing to all of these safety measures in order to ensure that we are keeping our patient data safe. If you are ever in doubt about the work you or others may be doing in {{orgName}}, please do not hesitate to reach out to the QA/QI directors and the IT director.

**This form must be signed every term regardless of whether you are a new or returning director or volunteer.**`;
