/**
 * Epic notification email templates for HAVEN Hub.
 *
 * Wording captured from the HAVEN Management Airtable automations on 2026-06-07.
 * Three automations were ported:
 *   - "Send Onboarding Emails" (NEW / MODIFY / RENEW variants)
 *   - "New Volunteer (NEW) Activation Email"
 *   - "Returning Volunteer (PW RESET) Activation Email"
 *
 * Note: the activation email's embedded YNHHS welcome-letter replica was
 * intentionally dropped and its password requirements inlined here.
 * This is flagged for review in the PR.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EpicEmailParams = {
  personName: string;
  netId?: string | null;
  contactEmail?: string | null;
  epicId?: string | null;
  departmentNames?: string[];
  kind?: "NEW" | "MODIFY" | "RENEW";
};

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

/** Escape user-supplied values before interpolating into HTML. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function p(text: string): string {
  return `<p>${text}</p>`;
}

// ---------------------------------------------------------------------------
// epicOnboardingEmail
// ---------------------------------------------------------------------------

export function epicOnboardingEmail(params: EpicEmailParams): { subject: string; html: string } {
  const { personName, netId, contactEmail, epicId, departmentNames = [], kind = "RENEW" } = params;

  const kindPhrase =
    kind === "NEW" ? "Account Request" : kind === "MODIFY" ? "Account Modification" : "Renewal";

  // Subjects are plain text mail headers, not HTML: no entity encoding.
  const subject = `[HAVEN] Epic ${kindPhrase} for ${personName}`;

  const isRenew = kind === "RENEW";

  const firstSentence = isRenew
    ? "we have submitted a request to renew your Epic account with YNHH through the coming term."
    : kind === "NEW"
      ? "we have submitted a request to create your new Epic account with YNHH for the coming term."
      : "we have submitted a request to modify your Epic account with YNHH.";

  const returningPermissionsSentence = isRenew
    ? " Because you are returning to your department, your permissions within Epic will not change. If you believe this is an error, or need additional permissions, please contact us by replying to this email."
    : "";

  const noRetrainingSentence = isRenew
    ? " Because you already have an existing Epic account, you will not be required to re-complete Epic training."
    : "";

  // Detail lines -- only include when values are present
  const detailLines: string[] = [];
  if (contactEmail) detailLines.push(`Your email: ${esc(contactEmail)}`);
  if (netId) detailLines.push(`Your Net ID: ${esc(netId)}`);

  const epicIdDisplay = epicId ? esc(epicId) : "pending assignment";
  if (isRenew) {
    detailLines.push(`Your Epic ID being renewed is ${epicIdDisplay}.`);
  } else {
    detailLines.push(`Your Epic ID: ${epicIdDisplay}`);
  }

  if (departmentNames.length > 0) {
    detailLines.push(`Department: ${departmentNames.map(esc).join(", ")}`);
  }

  const detailHtml = detailLines.map((line) => p(line)).join("\n");

  const html = `
<p>Hello ${esc(personName)},</p>

<p>We're reaching out to let you know that ${firstSentence}${returningPermissionsSentence}</p>

<p>As a reminder, permissions to access Epic come with great responsibility as you have access to patient PHI. You must adhere to YNHH HIPAA policy and local and state laws when accessing this information.${noRetrainingSentence} If you have any questions about this process, do not hesitate to reach out.</p>

${detailHtml}

<p>If any of this information is incorrect please let us know as soon as possible by replying to this email.</p>

<p>Best,<br>The HAVEN Free Clinic IT Directors</p>
`.trim();

  return { subject, html };
}

// ---------------------------------------------------------------------------
// epicActivationEmail
// ---------------------------------------------------------------------------

export function epicActivationEmail(params: EpicEmailParams): { subject: string; html: string } {
  const { personName, epicId } = params;

  const subject = "[HAVEN] New Epic Account Set-up";

  const epicIdDisplay = epicId ? esc(epicId) : "pending assignment";

  const html = `
<p>Hello ${esc(personName)},</p>

<p><strong>Your new Epic account has been successfully activated by YNHH.</strong></p>

<p>The following email contains your Epic username and instructions for setting up your new account. Please complete the training in order to get editing privileges that should match your directors.</p>

<h3>Please log in to your account within 48 hours, as your access will expire due to inactivity!</h3>

<p>Please call the Help Desk if it has already been 48 hours since your training has been completed if you still don't have editing privileges.</p>

<p>If you have any issues with your access or have issues logging in, you can reply to this email or call the YNHH Help Desk directly at 203-688-4357 (they are available 24/7). If you have trouble logging in on your personal device, try using the Yale VPN or Yale Secure network to access Epic first.</p>

<p>Your Network/Epic ID is: ${epicIdDisplay}</p>

<h2>Instructions for Setting Up Epic Account</h2>
<ul>
<li>If you haven't already, please download the Yale VPN at <a href="https://studenttechnology.yale.edu/new-students/set-virtual-private-network-vpn">https://studenttechnology.yale.edu/new-students/set-virtual-private-network-vpn</a>. Some users may find it easier to set up Epic access while using the Yale VPN.</li>
<li>Click <a href="https://passwordreset.ynhh.org/app/portal/">https://passwordreset.ynhh.org/app/portal/</a> and choose the Log-in option to enter your Epic ID and the temporary password: SecureCare4u#25. Alternatively, you can sign into <a href="https://owa.ynhh.org">https://owa.ynhh.org</a> to reset your temporary password if you are facing issues with the password reset portal.</li>
<li>Create a new password using the YNHHS password requirements: minimum of 15 characters, at least 1 uppercase letter, 1 lowercase letter, and 1 number; it cannot be one of your last 6 passwords. Passwords expire every 365 days.</li>
<li>Please write down your password as soon as you create it, so you don't forget it!</li>
<li>After you create your new password, set up the option to reset your password by YNHHS SMS Password Reset Code in the future by selecting the "My Details" tab and adding your mobile phone number. If you don't receive a text message when you attempt to reset your password in the future, please call the Helpdesk at 203-688-4357 to complete the set-up.</li>
</ul>

<h3>Instructions for Epic Training</h3>
<ol>
<li>Close all other browsers and use the Microsoft Edge browser (the preferred browser for the training site) to log in to <a href="https://ynhh.certpointsystems.com/">https://ynhh.certpointsystems.com/</a> with your Epic ID and new password. You may have to turn on the Yale VPN for this step. Note: access to the training system may not be available for 24-48 hours after receiving these instructions; if you encounter difficulties, please attempt to log in again tomorrow. If you are still having trouble accessing the site, please call or email the Helpdesk at <a href="mailto:Helpdesk@ynhh.org">Helpdesk@ynhh.org</a>.</li>
<li>Once you are logged in, search for the required training in the search engine at the top. The two trainings you need to take are: Epic Ambulatory Chart Review Online Class, and Epic Medical &amp; Advanced Practice Provider Student. If you complete the courses and the course completion status still reads as "Not Completed", please log out, close the site, then log in again to refresh.</li>
<li>Your Epic access will activate at 7 AM the next business day after all training courses are completed. If you complete training on the weekend, your access will not be active until Monday.</li>
</ol>

${EPIC_DOWNLOAD_AND_NOTES_HTML}

<p>Thank you,<br>HAVEN IT &amp; Communications Directors</p>
`.trim();

  return { subject, html };
}

// ---------------------------------------------------------------------------
// Shared blocks
// ---------------------------------------------------------------------------

/**
 * The "Downloading Epic" walkthrough plus the additional notes, shared verbatim
 * by the activation and password-reset emails (the legacy automations repeated
 * it word for word). Static legacy wording: contains no interpolations.
 */
const EPIC_DOWNLOAD_AND_NOTES_HTML = `
<h3>Downloading Epic</h3>
<ol>
<li>Download Citrix Receiver (but don't sign into it) at <a href="https://www.citrix.com/products/receiver/">https://www.citrix.com/products/receiver/</a></li>
<li>Log in through <a href="https://myapps.ynhh.org/vpn/index.html">https://myapps.ynhh.org/vpn/index.html</a>. Make sure you are on the Yale VPN if you are off campus. Bookmark this tab, as you will return to this page every time you want to enter Epic.</li>
<li>Enter your Epic username and new password.</li>
<li>Click on the application "PRD". Run the ".ica" file that is automatically downloaded if needed. <strong>You will NOT be able to log into Hyperspace until your training is completed, even though you have changed your password!</strong></li>
<li>Select the department "YM HAVEN FREE CLINIC [105370056]".</li>
</ol>

<p><strong>Additional Notes:</strong></p>
<ul>
<li>Do not select the department "HAVEN FREE CLINIC". This is different from "YM HAVEN FREE CLINIC".</li>
<li>Since we are not on DUO, please select the SMS option. You may need to call the Helpdesk and press 1 if you don't receive a text message to reset your password.</li>
<li>Everything you do and view within the Epic system is automatically tracked and logged for security purposes; to preserve HIPAA confidentiality, you should only view charts pertinent to your role at HAVEN.</li>
<li>Your password may need to be updated every 60-90 days. You should log into <a href="https://passwordreset.ynhh.org/app/portal/">https://passwordreset.ynhh.org/app/portal/</a> and select "Change Password" to create a new one, or you will be prompted within the Epic browser to update it.</li>
</ul>
`.trim();

// ---------------------------------------------------------------------------
// epicPasswordResetEmail
// ---------------------------------------------------------------------------

export function epicPasswordResetEmail(params: EpicEmailParams): { subject: string; html: string } {
  const { personName, epicId } = params;

  const subject = "[HAVEN] Epic Account Reset";

  const epicIdDisplay = epicId ? esc(epicId) : "pending assignment";

  const html = `
<p>Hello ${esc(personName)},</p>

<p>Your Epic account has been successfully re-activated by YNHH.</p>

<h3>ATTENTION: your password has been reset to "SecureCare4u#25" due to inactivity. Please log in to your account within 48 hours, as your access will expire due to inactivity!</h3>

<p>If you have any issues with your access or have issues logging in, you can reply to this email or call the YNHH Help Desk directly at 203-688-4357 (they are available 24/7). If you have trouble logging in on your personal device, try using the Yale VPN or Yale Secure network to access Epic first.</p>

<p>Your Network/Epic ID is: ${epicIdDisplay}<br>
Your temporary password: <strong>SecureCare4u#25</strong></p>

<ul>
<li>If you haven't already, please download the Yale VPN at <a href="https://studenttechnology.yale.edu/new-students/set-virtual-private-network-vpn">https://studenttechnology.yale.edu/new-students/set-virtual-private-network-vpn</a>. Some users may find it easier to set up Epic access while using the Yale VPN.</li>
<li>To reset your password, use <a href="https://passwordreset.ynhh.org/app/portal/">https://passwordreset.ynhh.org/app/portal/</a> and choose the Log-in option to enter your Epic ID and password. Alternatively, you can sign into <a href="https://owa.ynhh.org">https://owa.ynhh.org</a> to reset your password if you are facing issues with the password reset portal.</li>
<li>Please write down your password as soon as you create it, so you don't forget it!</li>
</ul>

${EPIC_DOWNLOAD_AND_NOTES_HTML}

<p>If you have any questions or concerns, please do not hesitate to reach out by replying to this email.</p>

<p>Thank you,<br>The HAVEN IT &amp; Communications Directors</p>
`.trim();

  return { subject, html };
}

// ---------------------------------------------------------------------------
// Template registry
// ---------------------------------------------------------------------------

export const EPIC_TEMPLATES = {
  "epic-onboarding": epicOnboardingEmail,
  "epic-activation": epicActivationEmail,
  "epic-password-reset": epicPasswordResetEmail,
} as const;

export type EpicTemplateKey = keyof typeof EPIC_TEMPLATES;
