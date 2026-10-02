/**
 * Starting points for a new form. Each is an ordinary layout that is copied
 * into the new Form and then edited freely; nothing links a form back to the
 * template it came from.
 */
import type { FormLayout } from "./layout";

export type FormTemplate = {
  id: string;
  title: string;
  description: string;
  /** Shown on the "new form" picker. */
  summary: string;
  layout: FormLayout;
};

const AGREE = ["Strongly agree", "Agree", "Neutral", "Disagree", "Strongly disagree"];

const RECRUITMENT_FEEDBACK: FormTemplate = {
  id: "recruitment-feedback",
  title: "Volunteer recruitment feedback",
  description:
    "Tell us how this term's recruitment went for you, from first hearing about HAVEN to your first shift. Your answers help us improve recruitment for the next class.",
  summary: "For newly recruited volunteers: outreach, application, interviews, decisions and onboarding.",
  layout: {
    questions: [
      {
        key: "heard_about",
        type: "multi_choice",
        label: "How did you first hear about volunteering with HAVEN?",
        options: ["Info session", "Friend or classmate", "Email or listserv", "Social media", "Class or professor", "Club fair"],
        allowOther: true,
        required: true,
      },
      {
        key: "applied_before",
        type: "single_choice",
        label: "Had you applied to HAVEN before this term?",
        options: ["No, this was my first time", "Yes, once before", "Yes, more than once"],
        required: true,
      },
      { key: "s_application", type: "section", label: "The application" },
      {
        key: "application_clear",
        type: "single_choice",
        label: "The application questions were clear.",
        options: AGREE,
        required: true,
      },
      {
        key: "application_time",
        type: "single_choice",
        label: "About how long did the application take you?",
        options: ["Under 30 minutes", "30 to 60 minutes", "1 to 2 hours", "More than 2 hours"],
      },
      {
        key: "department_info",
        type: "single_choice",
        label: "I had enough information about the departments to choose the right one for me.",
        options: AGREE,
        required: true,
      },
      { key: "s_interview", type: "section", label: "Interviews and decisions" },
      {
        key: "interviewed",
        type: "single_choice",
        label: "Did you have an interview?",
        options: ["Yes", "No"],
        required: true,
      },
      {
        key: "interview_experience",
        type: "rating",
        label: "How would you rate your interview experience?",
        scale: { max: 5, lowLabel: "Poor", highLabel: "Excellent" },
        visibleWhen: { field: "interviewed", op: "is", value: "Yes" },
      },
      {
        key: "decision_timely",
        type: "single_choice",
        label: "I heard back about my decision in a reasonable amount of time.",
        options: AGREE,
        required: true,
      },
      {
        key: "communication",
        type: "rating",
        label: "How clear was communication from HAVEN throughout recruitment?",
        scale: { max: 5, lowLabel: "Very unclear", highLabel: "Very clear" },
        required: true,
      },
      { key: "s_onboarding", type: "section", label: "Onboarding and training" },
      {
        key: "onboarding_clear",
        type: "single_choice",
        label: "After I was accepted, I knew what I needed to do before my first shift (contract, HIPAA, trainings).",
        options: AGREE,
        required: true,
      },
      {
        key: "training_prepared",
        type: "single_choice",
        label: "Training day prepared me for my role.",
        options: AGREE,
      },
      {
        key: "hardest_step",
        type: "single_choice",
        label: "Which step was the hardest to get through?",
        options: ["Application", "Interview", "Onboarding contract", "HIPAA certificate", "EHS trainings", "Training day", "Scheduling", "None were hard"],
      },
      { key: "s_overall", type: "section", label: "Overall" },
      {
        key: "overall",
        type: "rating",
        label: "Overall, how satisfied are you with the recruitment process?",
        scale: { max: 5, lowLabel: "Very dissatisfied", highLabel: "Very satisfied" },
        required: true,
      },
      {
        key: "went_well",
        type: "long_text",
        label: "What went well?",
      },
      {
        key: "improve",
        type: "long_text",
        label: "What is one thing we should change about recruitment?",
      },
      {
        key: "comments",
        type: "long_text",
        label: "Any other comments?",
      },
    ],
  },
};

/**
 * The SU26 mid-semester volunteer experience survey, rebuilt from its Airtable
 * form (base appkxTQ19GmaHgW1O, "Mid-Semester Feedback SU26"). The respondent
 * and department are not questions here: in the Hub the response is already
 * tied to the signed-in person.
 */
const VOLUNTEER_EXPERIENCE: FormTemplate = {
  id: "volunteer-experience",
  title: "Volunteer experience feedback",
  description:
    "A mid-term check-in on your experience volunteering with HAVEN. Your responses help leadership support you and your department.",
  summary: "Mid-term check-in for current volunteers, based on the SU26 Airtable survey.",
  layout: {
    questions: [
      {
        key: "update_channels",
        type: "multi_choice",
        label: "How do you typically receive updates about HAVEN?",
        help: "Select all that apply.",
        options: ["Emails", "Word of Mouth", "Text Message Group Chats", "Microsoft Teams", "Social Media"],
        allowOther: true,
      },
      {
        key: "informed",
        type: "single_choice",
        label: "How often do you feel adequately informed about HAVEN's operations, initiatives, and updates?",
        options: ["Always", "Often", "Sometimes", "Rarely", "Never"],
        required: true,
      },
      {
        key: "satisfaction",
        type: "rating",
        label: "How satisfied are you overall with this volunteer experience?",
        scale: { max: 5 },
        required: true,
      },
      {
        key: "scheduling",
        type: "single_choice",
        label: "How informed do you feel about ease of scheduling for the term?",
        options: ["Very Positive", "Positive", "Neutral", "Negative", "Very Negative"],
      },
      { key: "s_role", type: "section", label: "Your role and department" },
      { key: "meaningful", type: "single_choice", label: "I find my role at HAVEN meaningful.", options: AGREE, required: true },
      { key: "understand_role", type: "single_choice", label: "I clearly understand my roles and responsibilities at HAVEN.", options: AGREE, required: true },
      { key: "inclusive", type: "single_choice", label: "I feel that HAVEN fosters an inclusive and welcoming environment for all volunteers.", options: AGREE, required: true },
      { key: "supported", type: "single_choice", label: "I feel supported by my department leadership.", options: AGREE, required: true },
      {
        key: "dept_organization",
        type: "single_choice",
        label: "How would you rate the overall organization and structure of your department?",
        options: ["Excellent", "Good", "Fair", "Poor"],
        required: true,
      },
      {
        key: "leadership_responsiveness",
        type: "single_choice",
        label: "How would you rate responsiveness to communication from HAVEN leadership (e.g., responding to emails, attending meetings)?",
        options: ["Excellent", "Good", "Fair", "Poor"],
        required: true,
      },
      { key: "dept_well", type: "long_text", label: "What is one thing your department does well?" },
      { key: "dept_improve", type: "long_text", label: "What is one area of improvement for your department?" },
      { key: "s_involvement", type: "section", label: "Getting involved" },
      {
        key: "involvement",
        type: "multi_choice",
        label: "How would you like to become more involved with HAVEN?",
        help: "Select all that apply.",
        options: ["Leadership opportunities", "More patient interactions", "Research or Quality Improvement projects", "Community Outreach and Advocacy"],
        allowOther: true,
      },
      { key: "spanish", type: "single_choice", label: "Do you speak Spanish fluently?", options: ["Yes", "No", "Somewhat"] },
      { key: "abroad", type: "single_choice", label: "Are you abroad this term (outside of the United States or U.S. territories)?", options: ["Yes", "No"] },
      {
        key: "abroad_where",
        type: "short_text",
        label: "Where are you abroad?",
        visibleWhen: { field: "abroad", op: "is", value: "Yes" },
      },
      {
        key: "outside_activities",
        type: "single_choice",
        label: "Are you involved in any activities outside of HAVEN? (Clubs, internships, employment, research etc.)",
        options: ["Yes", "No"],
      },
      {
        key: "activity_kinds",
        type: "multi_choice",
        label: "What kinds of activities?",
        options: ["Clubs", "Internships", "Employment", "Research"],
        allowOther: true,
        visibleWhen: { field: "outside_activities", op: "is", value: "Yes" },
      },
      { key: "s_growth", type: "section", label: "Growth and feedback" },
      { key: "skills", type: "long_text", label: "What skills have you gained through HAVEN that will be valuable in your future career?" },
      { key: "support_growth", type: "long_text", label: "Is there anything HAVEN could do to better support your personal or professional growth?" },
      { key: "doing_well", type: "long_text", label: "What is something HAVEN is doing well that you would like to see continue?" },
      { key: "improve", type: "long_text", label: "What are some areas HAVEN could improve on?" },
      { key: "team_building", type: "long_text", label: "Are there any team-building activities or initiatives you would like to see implemented?" },
      { key: "change_one", type: "long_text", label: "If you could change one thing about HAVEN, what would it be?" },
      { key: "comments", type: "long_text", label: "Do you have any other comments, suggestions, or concerns?" },
    ],
  },
};

export const FORM_TEMPLATES: FormTemplate[] = [RECRUITMENT_FEEDBACK, VOLUNTEER_EXPERIENCE];

export function getTemplate(id: string | null | undefined): FormTemplate | undefined {
  return FORM_TEMPLATES.find((t) => t.id === id);
}
