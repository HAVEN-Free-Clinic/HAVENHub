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

/**
 * Hero screenshot of the dashboard, served from `public/email/`.
 *
 * ABSOLUTE, and it has to be: an email is read outside the app, so a relative
 * path resolves against the mail client and breaks. The file is committed
 * alongside this template rather than hotlinked, so the URL cannot rot
 * independently of the code that references it.
 *
 * 1104px wide for a 552px slot, so it stays sharp on a 2x display, and PNG
 * because the subject is UI: JPEG artifacts show up badly on small text and
 * flat fills. Roughly 66 KB, which keeps the whole message far below Gmail's
 * clipping threshold.
 *
 * `width` and `height` attributes are set on the tag because Outlook needs
 * them to reserve space, and the inline `max-width:100%;height:auto` is what
 * makes it scale on a phone.
 */
const HERO_URL = `${HUB_URL}/email/hero-dashboard.png`;

const FONT =
  "'Hanken Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * One bullet inside a capability group.
 *
 * A two-cell table row rather than `<ul><li>`, for the same reason `valueProp`
 * avoids lists: Outlook picks its own marker glyph and hanging indent, so real
 * list items would not line up with each other across groups. A fixed-width
 * marker cell makes every bullet in the message share one left edge.
 */
function bullet(body: string, opts: { last?: boolean } = {}): string {
  const gap = opts.last ? "0" : "8";
  return `        <tr>
          <td width="16" style="width:16px;padding:0 0 ${gap}px;font-family:${FONT};font-size:14px;line-height:1.55;color:#94a3b8;vertical-align:top;">&bull;</td>
          <td style="padding:0 0 ${gap}px;font-family:${FONT};font-size:14px;line-height:1.55;color:#475569;">${body}</td>
        </tr>`;
}

/** A bare bullet list, for prose sections that sit outside a capability card. */
function bulletList(items: string[]): string {
  const rows = items.map((b, i) => bullet(b, { last: i === items.length - 1 })).join("\n");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 20px;">
${rows}
      </table>`;
}

/**
 * One mini-section of the capability list: an uppercase eyebrow, a single line
 * orienting the reader, the bullets, and where to click to get there.
 *
 * Grouped cards rather than one long table of same-looking rows. A uniform list
 * of nine capabilities reads as a block of text and gets skipped wholesale; four
 * labelled cards let someone scan for the one heading they care about and stop
 * there. The eyebrow carries the only color in the card, so the groups separate
 * on glance without repeating the tinted fill that "Start here" uses to stand out.
 *
 * The rule that decides what earns a card: separation reads as "new topic", so a
 * facet of a capability has to sit INSIDE its parent rather than beside it. Who
 * you are on with is part of the schedule, not a peer of it, so it is a bullet
 * within SCHEDULING and must never be promoted to a card of its own. Splitting it
 * out is what made the previous flat panel read as nine unrelated things instead
 * of the handful it actually is.
 */
function capabilityGroup(g: {
  eyebrow: string;
  intro: string;
  bullets: string[];
  where: string;
  last?: boolean;
}): string {
  const rows = g.bullets.map((b, i) => bullet(b, { last: i === g.bullets.length - 1 })).join("\n");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #e2e8f0;border-radius:8px;background-color:#ffffff;margin:0 0 ${g.last ? "24" : "12"}px;">
  <tr>
    <td style="padding:16px 18px;">
      <p style="margin:0 0 6px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:${BRAND};">${g.eyebrow}</p>
      <p style="margin:0 0 11px;font-family:${FONT};font-size:15px;line-height:1.5;color:#0f172a;">${g.intro}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;">
${rows}
      </table>
      <p style="margin:12px 0 0;font-family:${FONT};font-size:13px;line-height:1.45;color:#64748b;">${g.where}</p>
    </td>
  </tr>
</table>`;
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

const WELCOME_BODY = `<a href="${HUB_URL}" style="text-decoration:none;"><img src="${HERO_URL}" width="552" height="268" alt="The HAVEN Hub dashboard, showing your next shift, your clearance status, and the modules available to you" style="display:block;width:100%;max-width:552px;height:auto;border:0;border-radius:8px;margin:0 0 24px;"></a>

<p style="margin:0 0 6px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:${BRAND};">Welcome aboard</p>

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

${capabilityGroup({
  eyebrow: "Stay in the loop",
  intro: "The Hub comes to you when something needs your attention, so nothing rests on you remembering to check.",
  bullets: [
    "The bell in the top bar collects your approvals, decisions, and reminders in one list, and carries an unread count until you have read them.",
    "Anything time-sensitive also goes out by email, and some notices arrive in Microsoft&nbsp;Teams, so you stay notified without living in the Hub.",
    "Those emails go to the contact address on your record, so keeping it current in <strong>My&nbsp;Info</strong> is what keeps them arriving.",
  ],
  where: "The bell sits in the top bar of every page, next to your photo.",
})}
${capabilityGroup({
  eyebrow: "My Info",
  intro: "Everything the clinic holds about you in one place, including the clearance you need before your first shift.",
  bullets: [
    "Your photo and contact details, so the schedule and the front desk know who you are and how to reach you.",
    "Your HIPAA and EHS training: what is on file, what is expiring, and what is still outstanding.",
    "The languages you speak. Add them here or on your application and the interpreting department confirms each one; once confirmed, you show up as a language provider on the schedule.",
    "Your service record. Every shift you serve is recorded, and you can download a verified Record of Service whenever you need proof for a residency application or a scholarship.",
  ],
  where: "Open <strong>My&nbsp;Info</strong> from the top navigation.",
})}
${capabilityGroup({
  eyebrow: "Scheduling",
  intro: "Your shifts, everyone else&rsquo;s, and a way to get both into the calendar you already use.",
  bullets: [
    "Your upcoming shifts, with a swap request when something comes up.",
    "The full clinic schedule: who is working each department, on any clinic day.",
    "<strong>Who is on with you.</strong> The same schedule names which attending is covering the clinic, and who is a verified language provider or a licensed RN, so you can find the right person mid-shift instead of asking around.",
    "A calendar subscription. Set it up once and your shifts appear automatically in Outlook, Google Calendar, or Apple Calendar.",
  ],
  where:
    "<strong>Schedule</strong> in the top navigation: <strong>My schedule</strong> for yours, <strong>Full schedule</strong> for everyone&rsquo;s.",
})}
${capabilityGroup({
  eyebrow: "Also in the Hub",
  intro: "Three more things you will use, each with its own tab.",
  bullets: [
    "<strong>Training.</strong> The self-paced courses your department assigns, on your own time, with progress that updates as you go.",
    "<strong>IT &amp; Epic support.</strong> File a tech request or ask for Epic&nbsp;/&nbsp;YNHH access, then follow it from submitted to resolved without chasing anyone by email.",
    "<strong>Report a concern.</strong> Anyone can raise a professional-standards concern, confidentially and anonymously if you prefer, so the team can look into it and follow up.",
  ],
  where: "<strong>Learning</strong>, <strong>Support</strong>, and <strong>Incidents</strong> in the top navigation.",
  last: true,
})}

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

${bulletList([
  "Press <strong>Cmd&nbsp;+&nbsp;K</strong> (or <strong>Ctrl&nbsp;+&nbsp;K</strong>) anywhere to jump to a page or search for a person.",
  "The Hub follows your device&rsquo;s light or dark setting. To pin one instead, use the theme button in the top bar.",
])}

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
