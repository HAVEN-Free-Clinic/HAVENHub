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

const WELCOME_BODY = `<p style="margin:0 0 6px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:${BRAND};">Welcome aboard</p>

<h1 style="margin:0 0 14px;font-family:${FONT};font-size:24px;line-height:1.25;font-weight:700;color:#0f172a;">Hi {{#if firstName}}{{firstName}}{{else}}there{{/if}}, welcome to HAVEN&nbsp;Hub</h1>

<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.6;color:#1e293b;">HAVEN&nbsp;Hub is your new home base for everything you do at HAVEN Free Clinic. One sign-in with your Yale account brings your schedule, your compliance, your training, and support together in a single place.</p>

<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 10px;">
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
  "Keep your contact details current, track your HIPAA certification, and see exactly what&rsquo;s left before you&rsquo;re cleared to volunteer &mdash; all under <strong>My&nbsp;Info</strong>.",
)}
${featureRow(
  "The clinic schedule",
  "See your upcoming shifts, view the full clinic schedule, and request a swap when something comes up.",
)}
${featureRow(
  "Training &amp; learning",
  "Complete the self-paced courses your department assigns, on your own time, and watch your progress update automatically.",
)}
${featureRow(
  "IT &amp; Epic support",
  "File a tech request or ask for Epic&nbsp;/&nbsp;YNHH access, then follow it from submitted to resolved without chasing anyone by email.",
)}
${featureRow(
  "Report a concern",
  "Anyone can raise a professional-standards concern, confidentially, so the team can look into it and follow up.",
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
        <tr><td style="padding:0 0 9px;font-family:${FONT};font-size:14px;line-height:1.5;color:#1e293b;"><strong style="color:${BRAND};">1.</strong>&nbsp;&nbsp;Sign in at hub.havenfreeclinic.org with your Yale account.</td></tr>
        <tr><td style="padding:0 0 9px;font-family:${FONT};font-size:14px;line-height:1.5;color:#1e293b;"><strong style="color:${BRAND};">2.</strong>&nbsp;&nbsp;Open <strong>My&nbsp;Info</strong> and finish anything still outstanding.</td></tr>
        <tr><td style="padding:0;font-family:${FONT};font-size:14px;line-height:1.5;color:#1e293b;"><strong style="color:${BRAND};">3.</strong>&nbsp;&nbsp;Explore the modules waiting for you on your dashboard.</td></tr>
      </table>
    </td>
  </tr>
</table>

<hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 24px;">

<h3 style="margin:0 0 8px;font-family:${FONT};font-size:16px;line-height:1.3;font-weight:700;color:#0f172a;">Need a hand?</h3>

<p style="margin:0 0 14px;font-family:${FONT};font-size:16px;line-height:1.6;color:#1e293b;">Every page in HAVEN&nbsp;Hub has a <strong>Help</strong> button with search and answers built in. For step-by-step guides to every feature, our documentation is always a click away.</p>

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
