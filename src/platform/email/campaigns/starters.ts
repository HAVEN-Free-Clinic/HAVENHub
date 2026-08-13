/**
 * Campaign starters: source-controlled, ready-to-send campaign content an admin can
 * pick when creating a new campaign ("Start from ..."). Selecting a starter seeds the
 * draft's subject + body; from there it is an ordinary editable draft.
 *
 * Authoring constraints (enforced by `starters.test.ts`):
 *   - A campaign body renders inside the shared layout wrapper (`templates/layout.ts`)
 *     -- the Yale-blue header band with the "HAVEN Free Clinic" wordmark and the slate
 *     footer come from there. A starter authors ONLY the content slot; it must not
 *     recreate the document, header, or footer.
 *   - The only merge variables a campaign body may reference are `firstName` and
 *     `name` (see `audience/variables.ts`). Any other `{{ token }}` makes
 *     `updateCampaign` reject the body on Save/Send -- so the brand color and every
 *     link below are hard-coded literals, not `{{ brandColor }}` / `{{ ... }}` tokens.
 *   - The render engine supports only `{{var}}`, `{{{raw}}}`, and
 *     `{{#if x}}...{{else}}...{{/if}}` -- there is no `{{#each}}`.
 *
 * The HTML is table-based with inline styles so it renders in Outlook / OWA (the
 * primary Yale clients) as well as Apple Mail and Gmail. Colors and radii track the
 * HAVEN Hub design system: Yale-blue `#00356b`, the layout's slate palette, 8px cards
 * and 6px buttons.
 */

export type CampaignStarter = {
  /** Stable id used by the "Start from" chooser and `getStarter`. */
  id: string;
  /** Default campaign name when the creator leaves the name blank. */
  name: string;
  /** Short label shown in the chooser. */
  label: string;
  /** One-line helper text shown under the label in the chooser. */
  description: string;
  /** Campaign subject (may use `firstName` / `name`). */
  subject: string;
  /** Campaign body HTML for the layout content slot (may use `firstName` / `name`). */
  body: string;
};

// Yale blue -- hard-coded rather than `{{ brandColor }}` because a campaign body only
// resolves `firstName` / `name`. Kept in sync with the default `branding.brandColor`.
const BRAND = "#00356b";
const HUB_URL = "https://hub.havenfreeclinic.org";
const DOCS_URL = "https://docs.havenfreeclinic.org";

const FONT =
  "'Hanken Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** One capability row in the "What you can do here" panel. */
function featureRow(title: string, body: string, opts: { last?: boolean } = {}): string {
  const border = opts.last ? "" : "border-bottom:1px solid #eef2f7;";
  return `      <tr>
        <td style="padding:16px 18px;${border}">
          <p style="margin:0 0 3px;font-family:${FONT};font-size:15px;font-weight:600;color:#0f172a;">${title}</p>
          <p style="margin:0;font-family:${FONT};font-size:14px;line-height:1.5;color:#475569;">${body}</p>
        </td>
      </tr>`;
}

/**
 * One centered value-proposition line under the heading.
 *
 * Centered single lines rather than a bulleted list: at 600px an emphasised
 * fragment plus a short tail reads as a headline, and Outlook renders list
 * markers inconsistently enough that three <li> would be three different shapes.
 */
function valueProp(lead: string, rest: string, opts: { last?: boolean } = {}): string {
  return `<p style="margin:0 0 ${opts.last ? "24" : "10"}px;text-align:center;font-family:${FONT};font-size:17px;line-height:1.35;color:#0f172a;"><span style="font-weight:700;">${lead}</span> ${rest}</p>`;
}

/** One numbered step in the "Start here" panel. */
function step(n: number, body: string, opts: { last?: boolean } = {}): string {
  return `        <tr><td style="padding:0 0 ${opts.last ? "0" : "9"}px;font-family:${FONT};font-size:14px;line-height:1.5;color:#1e293b;"><strong style="color:${BRAND};">${n}.</strong>&nbsp;&nbsp;${body}</td></tr>`;
}

const WELCOME_BODY = `<p style="margin:0 0 6px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:${BRAND};">Welcome aboard</p>

<h1 style="margin:0 0 14px;font-family:${FONT};font-size:26px;line-height:1.22;font-weight:700;letter-spacing:-0.4px;color:#0f172a;">Hi {{#if firstName}}{{firstName}}{{else}}there{{/if}}, welcome to HAVEN&nbsp;Hub</h1>

<p style="margin:0 0 22px;font-family:${FONT};font-size:16px;line-height:1.6;color:#1e293b;">HAVEN&nbsp;Hub is your home base for everything you do at HAVEN Free Clinic. One sign-in with your Yale account brings your shifts, your clearance, your training, and support together in a single place.</p>

${valueProp("One sign-in", "with your Yale account.")}
${valueProp("Every shift and requirement", "in one place.")}
${valueProp("Built for HAVEN", "volunteers, by HAVEN volunteers.", { last: true })}

<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 10px;">
  <tr>
    <td style="border-radius:6px;background-color:${BRAND};">
      <a href="${HUB_URL}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Open HAVEN&nbsp;Hub &rarr;</a>
    </td>
  </tr>
</table>

<p style="margin:0 0 24px;font-family:${FONT};font-size:13px;line-height:1.5;color:#64748b;">Sign in at <a href="${HUB_URL}" style="color:${BRAND};text-decoration:underline;">hub.havenfreeclinic.org</a> with your Yale credentials &mdash; no separate password to remember.</p>

<hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 24px;">

<p style="margin:0 0 4px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:${BRAND};">What you can do here</p>
<h2 style="margin:0 0 16px;font-family:${FONT};font-size:19px;line-height:1.3;font-weight:700;color:#0f172a;">Everything in one place</h2>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #e2e8f0;border-radius:8px;background-color:#ffffff;margin:0 0 24px;">
${featureRow(
  "Your profile &amp; clearance",
  "Add a photo, keep your contact details current, and track your HIPAA and EHS training. <strong>My&nbsp;Info</strong> shows exactly what is left before you are cleared to volunteer, so nothing is a surprise on a Saturday morning.",
)}
${featureRow(
  "The clinic schedule",
  "See your upcoming shifts, browse the full clinic schedule, and request a swap when something comes up. Subscribe once and your shifts appear automatically in Outlook, Google Calendar, or Apple Calendar.",
)}
${featureRow(
  "Who is on with you",
  "The full schedule shows who is working each department, which attending is covering the clinic, and who is a verified language provider or a licensed RN &mdash; so you can find the right person without asking around.",
)}
${featureRow(
  "The languages you speak",
  "Tell us on your application or in <strong>My&nbsp;Info</strong>, and the interpreting department confirms each one. Once confirmed, you show up as a language provider on the schedule.",
)}
${featureRow(
  "Training &amp; learning",
  "Complete the self-paced courses your department assigns, on your own time, and watch your progress update as you go.",
)}
${featureRow(
  "IT &amp; Epic support",
  "File a tech request or ask for Epic&nbsp;/&nbsp;YNHH access, then follow it from submitted to resolved without chasing anyone by email.",
)}
${featureRow(
  "Your Record of Service",
  "Every shift you serve is recorded. When you need proof for a residency application or a scholarship, download a verified Record of Service with the dates and hours you volunteered.",
)}
${featureRow(
  "Report a concern",
  "Anyone can raise a professional-standards concern, confidentially and anonymously if you prefer, so the team can look into it and follow up.",
)}
${featureRow(
  "Stay in the loop",
  "Get notified the way that works for you &mdash; the in-app bell, email, and Microsoft&nbsp;Teams &mdash; so nothing important slips by.",
  { last: true },
)}
</table>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background-color:#eef3fb;border:1px solid #d5e2f2;border-radius:8px;margin:0 0 24px;">
  <tr>
    <td style="padding:18px 20px;">
      <p style="margin:0 0 12px;font-family:${FONT};font-size:15px;font-weight:700;color:${BRAND};">Start here</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;">
${step(1, "Sign in at hub.havenfreeclinic.org with your Yale account.")}
${step(2, "Open <strong>My&nbsp;Info</strong> and finish anything still outstanding.")}
${step(3, "Check <strong>My schedule</strong> and subscribe to your shifts.")}
${step(4, "Explore the modules waiting for you on your dashboard.", { last: true })}
      </table>
    </td>
  </tr>
</table>

<hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 24px;">

<h3 style="margin:0 0 8px;font-family:${FONT};font-size:16px;line-height:1.3;font-weight:700;color:#0f172a;">A few things worth knowing</h3>

<p style="margin:0 0 20px;font-family:${FONT};font-size:16px;line-height:1.6;color:#1e293b;">Press <strong>Cmd&nbsp;+&nbsp;K</strong> (or <strong>Ctrl&nbsp;+&nbsp;K</strong>) anywhere to jump to a page or search for a person. The Hub follows your device&rsquo;s light or dark setting, and you can pin either one from the account menu.</p>

<h3 style="margin:0 0 8px;font-family:${FONT};font-size:16px;line-height:1.3;font-weight:700;color:#0f172a;">Need a hand?</h3>

<p style="margin:0 0 14px;font-family:${FONT};font-size:16px;line-height:1.6;color:#1e293b;">Every page has a <strong>Help</strong> button with search and answers built in. For step-by-step guides to every feature, our documentation is always a click away.</p>

<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 10px;">
  <tr>
    <td style="border-radius:6px;border:1px solid ${BRAND};">
      <a href="${DOCS_URL}" style="display:inline-block;padding:11px 22px;font-family:${FONT};font-size:14px;font-weight:600;color:${BRAND};text-decoration:none;">Browse the docs &rarr;</a>
    </td>
  </tr>
</table>

<p style="margin:0 0 4px;font-family:${FONT};font-size:13px;line-height:1.5;color:#64748b;">Or go straight to <a href="${DOCS_URL}" style="color:${BRAND};text-decoration:underline;">docs.havenfreeclinic.org</a>.</p>

<p style="margin:26px 0 0;font-family:${FONT};font-size:16px;line-height:1.6;color:#1e293b;">Welcome aboard,<br><strong>The HAVEN Free Clinic team</strong></p>`;

export const CAMPAIGN_STARTERS: CampaignStarter[] = [
  {
    id: "welcome",
    name: "Welcome to HAVEN Hub",
    label: "Welcome to HAVEN Hub",
    description: "A polished intro to the platform for all affiliates, ready to review and send.",
    subject: "Welcome to HAVEN Hub{{#if firstName}}, {{firstName}}{{/if}}",
    body: WELCOME_BODY,
  },
];

const BY_ID = new Map(CAMPAIGN_STARTERS.map((s) => [s.id, s]));

export function getStarter(id: string): CampaignStarter | undefined {
  return BY_ID.get(id);
}
