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
export type ApplicantWithdrewParams = {
  /** Full name of the applicant who withdrew. */
  applicantName: string;
  /** The recruitment cycle's title. */
  cycleTitle: string;
  /** True when they were declining an offer rather than withdrawing from review. */
  declinedOffer: boolean;
  /** True when they had an interview on the schedule. */
  hadScheduledInterview: boolean;
  /** Comma-joined department codes affected, e.g. "SRHD, MDIC". */
  departments: string;
  /** Absolute link to the applicant's detail page. */
  reviewLink: string;
};

/** Build the flat render-engine context for recruitment.applicant_withdrew.
 *  Department codes arrive pre-joined: the render engine has no {{#each}}. */
export function applicantWithdrewContext(p: ApplicantWithdrewParams): Record<string, unknown> {
  return {
    applicantName: p.applicantName,
    cycleTitle: p.cycleTitle,
    declinedOffer: p.declinedOffer,
    hadScheduledInterview: p.hadScheduledInterview,
    departments: p.departments,
    reviewLink: p.reviewLink,
  };
}

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
      { name: "applicantNote", label: "Note to applicant (optional)", sampleValue: "Please bring a copy of your CV." },
    ],
    defaultSubject: "HAVEN {{ departmentName }} director interview",
    defaultBody:
      "<p>Hi {{ firstName }},</p><p>You're invited to a director interview for <strong>{{ departmentName }}</strong> at HAVEN Free Clinic.</p><p>Time: {{ interviewTime }}<br/>Join: {{{ joinLink }}}</p>{{#if applicantNote}}<p>{{ applicantNote }}</p>{{/if}}<p>Please reply if you need to reschedule.</p>",
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
    key: "recruitment.review_digest",
    name: "Recruitment: daily review digest (directors)",
    category: "transactional",
    group: "recruitment",
    variables: [
      { name: "firstName", label: "Director first name", sampleValue: "Sam" },
      { name: "count", label: "Number of applications to review", sampleValue: "3" },
      { name: "noun", label: "application / applications", sampleValue: "applications" },
      { name: "departmentName", label: "Department name(s)", sampleValue: "Student Run Health Department" },
      { name: "reviewUrl", label: "Recruitment review URL", sampleValue: "https://hub.havenfreeclinic.com/recruitment" },
    ],
    defaultSubject: "You have {{ count }} {{ noun }} to review",
    defaultBody:
      '<p>Hi {{ firstName }},</p><p>You have <strong>{{ count }}</strong> {{ noun }} awaiting review for {{ departmentName }}.</p><p>Review them here: <a href="{{ reviewUrl }}">{{ reviewUrl }}</a></p>',
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
      '<p>Congratulations {{ firstName }},</p><p>To finish joining HAVEN for {{ cycleTitle }}, please complete your onboarding contract here: <a href="{{ contractUrl }}">{{ contractUrl }}</a></p><p>It collects your signatures, Epic access details, and HIPAA certificate.</p>',
  },
  {
    key: "recruitment.onboarding_confirmation",
    name: "Recruitment: onboarding confirmation",
    category: "transactional",
    group: "recruitment",
    // Every value here is passed pre-computed from the shared next-steps
    // content module (src/modules/recruitment/onboarding-next-steps.ts) so
    // this email, the completion screen, and the revisit page never drift
    // from one another. signInText is signIn.emailText (NOT signIn.text)
    // flattened to a top-level key: the render engine does flat context[key]
    // lookup only, so a raw "{{ signIn.emailText }}" would silently render
    // empty. emailText, not text, because this email is a durable record
    // rendered once at submit time and opened at some unknown later point --
    // it cannot know whether the volunteer has a Person to sign in as by the
    // time they read it (see the doc comment on signIn.emailText), so it is
    // always phrased against the future roster-add rather than the send-time
    // state. training is likewise nullable (empty when the cycle has no
    // in-person training date scheduled) and wrapped in {{#if}} the same way
    // epic already is. loginUrl is the one field OnboardingNextSteps carries
    // that is not a bullet (loginPath), resolved to an absolute URL the same
    // way shift-reminders.ts and reminders.ts do (getSetting("app.baseUrl") +
    // the path) since this is the one surface of the three with no
    // surrounding app to navigate from: without it, the signInText bullet
    // names an action with no way to take it.
    //
    // The anchor text is deliberately "HAVEN Hub sign-in page", not a
    // "Sign in to HAVEN Hub" call to action: the two screens gate that exact
    // button on hasAccount (see next-steps-screen.tsx), but this email cannot,
    // since hasAccount can flip between send time and whenever it is opened.
    // A brand-new volunteer who is SUBMITTED but not yet PROMOTED could click
    // an imperative "sign in" button, complete SSO, and land on /welcome's
    // "we couldn't find you" dead end -- the exact failure this fix removes,
    // reappearing one bullet down from the corrected copy. Naming the
    // destination rather than commanding the action keeps the link (genuinely
    // useful later, and this durable record is the right place to keep it)
    // without asserting it will succeed right now.
    variables: [
      { name: "firstName", label: "Applicant first name", sampleValue: "Sam" },
      { name: "cycleTitle", label: "Cycle title", sampleValue: "Volunteer SU26" },
      { name: "signInText", label: "How to sign in once added to the roster (SSO or magic link), phrased for a durable email read at an unknown later time", sampleValue: "Once a recruitment lead adds you to the roster, sign in with your Yale NetID." },
      { name: "training", label: "Training date and location, empty when the cycle has no scheduled date", sampleValue: "Plan to attend in-person training on Saturday, August 15 in the HAVEN clinic." },
      { name: "epic", label: "Epic follow-up, empty when there is nothing to tell this volunteer about Epic", sampleValue: "The IT team will set up your Epic account and email you sign-in instructions once it is ready." },
      { name: "review", label: "Review status", sampleValue: "A recruitment lead will review your submission and add you to the roster." },
      { name: "loginUrl", label: "Sign-in page URL", sampleValue: "https://hub.havenfreeclinic.com/login" },
    ],
    defaultSubject: "Your HAVEN {{ cycleTitle }} onboarding is complete",
    defaultBody:
      '<p>Congratulations {{ firstName }},</p><p>You\'ve completed your HAVEN onboarding for {{ cycleTitle }}. Here is what happens next:</p><ul><li>{{ signInText }}</li>{{#if training}}<li>{{ training }}</li>{{/if}}{{#if epic}}<li>{{ epic }}</li>{{/if}}<li>{{ review }}</li></ul><p><a href="{{ loginUrl }}">HAVEN Hub sign-in page</a></p>',
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
  {
    key: "recruitment.applicant_withdrew",
    name: "Recruitment: applicant withdrew",
    category: "transactional",
    group: "recruitment",
    variables: [
      { name: "applicantName", label: "Applicant who withdrew", sampleValue: "Reed Rivers" },
      { name: "cycleTitle", label: "Recruitment cycle title", sampleValue: "Volunteer 2026" },
      { name: "declinedOffer", label: "True when they declined an offer", sampleValue: "false" },
      { name: "hadScheduledInterview", label: "True when an interview was on the schedule", sampleValue: "true" },
      { name: "departments", label: "Affected department codes (comma-joined)", sampleValue: "SRHD, MDIC" },
      { name: "reviewLink", label: "Link to the applicant detail page", sampleValue: "https://hub.havenfreeclinic.org/recruitment" },
    ],
    defaultSubject: "[HAVEN] {{ applicantName }} withdrew from {{ cycleTitle }}",
    defaultBody: `<p>Hello,</p>

{{#if declinedOffer}}<p>{{ applicantName }} declined their offer for {{ cycleTitle }} ({{ departments }}).</p>

<p>Their acceptance and any onboarding paperwork are still on file and unchanged. Rescind the acceptance on the Decisions page, or withdraw the onboarding contract first if one was already sent.</p>{{else}}<p>{{ applicantName }} withdrew their application to {{ cycleTitle }} ({{ departments }}).</p>{{/if}}

{{#if hadScheduledInterview}}<p>They had an interview on the schedule. It has not been cancelled automatically, so the slot is still held until someone removes it.</p>{{/if}}

<p>They no longer appear in the review queue.</p>

<p><a href="{{ reviewLink }}">Open recruitment</a></p>

<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
];
