import type { TemplateDescriptor } from "./types";

/**
 * Recruitment email templates. Registered here so admins can edit a global
 * default for each (in /admin/email/templates) and so each cycle can override
 * them (see src/modules/recruitment/email/render.ts). These replace the former
 * inline-HTML functions; the render engine handles HTML escaping, so bodies are
 * pure interpolation and values are passed raw in the context.
 *
 * joinLink is rendered raw ({{{ }}}) because its context builder emits either an
 * anchor tag or the plain fallback text. All other values use escaped {{ }}.
 */
export const recruitmentDescriptors: TemplateDescriptor[] = [
  {
    key: "recruitment.acceptance",
    name: "Recruitment: acceptance",
    category: "transactional",
    group: "recruitment",
    variables: [
      { name: "firstName", label: "Applicant first name", sampleValue: "Sam" },
      { name: "cycleTitle", label: "Cycle title", sampleValue: "Volunteer SU26" },
      { name: "departmentName", label: "Department name", sampleValue: "Student Run Health Department" },
    ],
    defaultSubject: "You've been accepted to HAVEN: {{ departmentName }}",
    defaultBody:
      "<p>Congratulations {{ firstName }},</p><p>You've been accepted into <strong>{{ departmentName }}</strong> for {{ cycleTitle }}. We'll follow up shortly with onboarding next steps.</p>",
  },
  {
    key: "recruitment.interview_invite",
    name: "Recruitment: interview invitation",
    category: "transactional",
    group: "recruitment",
    variables: [
      { name: "firstName", label: "Applicant first name", sampleValue: "Sam" },
      { name: "departmentName", label: "Department name", sampleValue: "Student Run Health Department" },
      { name: "interviewTime", label: "Interview date and time", sampleValue: "Monday, April 15, 2026 at 6:30 PM" },
      { name: "joinLink", label: "Join link (HTML)", sampleValue: '<a href="https://zoom.us/j/123">https://zoom.us/j/123</a>' },
    ],
    defaultSubject: "HAVEN {{ departmentName }} director interview",
    defaultBody:
      "<p>Hi {{ firstName }},</p><p>You're invited to a director interview for <strong>{{ departmentName }}</strong> at HAVEN Free Clinic.</p><p>Time: {{ interviewTime }}<br/>Join: {{{ joinLink }}}</p><p>Please reply if you need to reschedule.</p>",
  },
  {
    key: "recruitment.interview_assignment",
    name: "Recruitment: interview panel assignment",
    category: "transactional",
    group: "recruitment",
    variables: [
      { name: "panelistFirstName", label: "Panelist first name", sampleValue: "Sam" },
      { name: "candidateName", label: "Candidate name", sampleValue: "Jordan Lee" },
      { name: "departmentName", label: "Department name", sampleValue: "Student Run Health Department" },
      { name: "interviewsUrl", label: "My interviews URL", sampleValue: "https://hub.havenfreeclinic.com/recruitment/interviews" },
    ],
    defaultSubject: "You're on the interview panel for {{ candidateName }}",
    defaultBody:
      '<p>Hi {{ panelistFirstName }},</p><p>You\'ve been added to the interview panel for <strong>{{ candidateName }}</strong> ({{ departmentName }} director interview).</p><p>Review the schedule and submit your evaluation from your My interviews page: <a href="{{ interviewsUrl }}">{{ interviewsUrl }}</a></p>',
  },
  {
    key: "recruitment.onboarding",
    name: "Recruitment: onboarding link",
    category: "transactional",
    group: "recruitment",
    variables: [
      { name: "firstName", label: "Applicant first name", sampleValue: "Sam" },
      { name: "cycleTitle", label: "Cycle title", sampleValue: "Volunteer SU26" },
      { name: "contractUrl", label: "Onboarding link URL", sampleValue: "https://hub.havenfreeclinic.com/onboard/abc123" },
    ],
    defaultSubject: "Complete your HAVEN onboarding for {{ cycleTitle }}",
    defaultBody:
      '<p>Congratulations {{ firstName }},</p><p>To finish joining HAVEN for {{ cycleTitle }}, please complete your onboarding contract here: <a href="{{ contractUrl }}">{{ contractUrl }}</a></p><p>It collects your signatures, EPIC access details, and HIPAA certificate.</p>',
  },
  {
    key: "recruitment.application_received",
    name: "Recruitment: application received",
    category: "transactional",
    group: "recruitment",
    variables: [
      { name: "firstName", label: "Applicant first name", sampleValue: "Sam" },
      { name: "cycleTitle", label: "Cycle title", sampleValue: "Volunteer SU26" },
    ],
    defaultSubject: "We received your {{ cycleTitle }} application",
    defaultBody:
      "<p>Hi {{ firstName }},</p><p>Thanks for applying to HAVEN Free Clinic. We have received your {{ cycleTitle }} application and will be in touch.</p>",
  },
  {
    key: "recruitment.portal_link",
    name: "Recruitment: application link (magic link)",
    category: "transactional",
    group: "recruitment",
    variables: [
      { name: "firstName", label: "Applicant first name", sampleValue: "Sam" },
      { name: "portalUrl", label: "Magic link URL", sampleValue: "https://hub.havenfreeclinic.com/apply/verify?token=abc" },
    ],
    defaultSubject: "Your HAVEN Hub application link",
    defaultBody:
      '<p>Hi {{ firstName }},</p><p>Use this link to access your HAVEN Hub application. It expires in 30 minutes and can be used once.</p><p><a href="{{ portalUrl }}">Open my application</a></p><p>If you did not request this, you can ignore this email.</p>',
  },
];
