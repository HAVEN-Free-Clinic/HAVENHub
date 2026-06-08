/**
 * Golden-master tests for epic email templates via renderEmail.
 *
 * These tests assert that the new descriptor + renderEmail system produces
 * byte-identical output compared to the pre-refactor epicOnboardingEmail /
 * epicActivationEmail / epicPasswordResetEmail functions.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { renderEmail } from "./renderEmail";
import {
  epicOnboardingContext,
  epicActivationContext,
  epicPasswordResetContext,
} from "./epic";

beforeEach(resetDb);

describe("epic templates via renderEmail (passthrough layout)", () => {
  // ---------------------------------------------------------------------------
  // epic-onboarding NEW
  // ---------------------------------------------------------------------------

  it("epic-onboarding NEW matches pre-refactor output", async () => {
    const out = await renderEmail(
      "epic-onboarding",
      epicOnboardingContext({
        personName: "Alice Smith",
        netId: "as123",
        contactEmail: "alice@yale.edu",
        epicId: "ASMITH",
        departmentNames: ["Outreach", "Triage"],
        kind: "NEW",
      }),
    );
    expect(out.subject).toBe("[HAVEN] Epic Account Request for Alice Smith");
    expect(out.html).toBe(
      "<p>Hello Alice Smith,</p>\n\n<p>We're reaching out to let you know that we have submitted a request to create your new Epic account with YNHH for the coming term.</p>\n\n<p>As a reminder, permissions to access Epic come with great responsibility as you have access to patient PHI. You must adhere to YNHH HIPAA policy and local and state laws when accessing this information. If you have any questions about this process, do not hesitate to reach out.</p>\n\n<p>Your email: alice@yale.edu</p>\n<p>Your Net ID: as123</p>\n<p>Your Epic ID: ASMITH</p>\n<p>Department: Outreach, Triage</p>\n\n<p>If any of this information is incorrect please let us know as soon as possible by replying to this email.</p>\n\n<p>Best,<br>The HAVEN Free Clinic IT Directors</p>",
    );
  });

  // ---------------------------------------------------------------------------
  // epic-onboarding MODIFY
  // ---------------------------------------------------------------------------

  it("epic-onboarding MODIFY matches pre-refactor output", async () => {
    const out = await renderEmail(
      "epic-onboarding",
      epicOnboardingContext({
        personName: "Alice Smith",
        netId: "as123",
        contactEmail: "alice@yale.edu",
        epicId: "ASMITH",
        departmentNames: ["Outreach", "Triage"],
        kind: "MODIFY",
      }),
    );
    expect(out.subject).toBe("[HAVEN] Epic Account Modification for Alice Smith");
    expect(out.html).toBe(
      "<p>Hello Alice Smith,</p>\n\n<p>We're reaching out to let you know that we have submitted a request to modify your Epic account with YNHH.</p>\n\n<p>As a reminder, permissions to access Epic come with great responsibility as you have access to patient PHI. You must adhere to YNHH HIPAA policy and local and state laws when accessing this information. If you have any questions about this process, do not hesitate to reach out.</p>\n\n<p>Your email: alice@yale.edu</p>\n<p>Your Net ID: as123</p>\n<p>Your Epic ID: ASMITH</p>\n<p>Department: Outreach, Triage</p>\n\n<p>If any of this information is incorrect please let us know as soon as possible by replying to this email.</p>\n\n<p>Best,<br>The HAVEN Free Clinic IT Directors</p>",
    );
  });

  // ---------------------------------------------------------------------------
  // epic-onboarding RENEW
  // ---------------------------------------------------------------------------

  it("epic-onboarding RENEW matches pre-refactor output", async () => {
    const out = await renderEmail(
      "epic-onboarding",
      epicOnboardingContext({
        personName: "Alice Smith",
        netId: "as123",
        contactEmail: "alice@yale.edu",
        epicId: "ASMITH",
        departmentNames: ["Outreach", "Triage"],
        kind: "RENEW",
      }),
    );
    expect(out.subject).toBe("[HAVEN] Epic Renewal for Alice Smith");
    expect(out.html).toBe(
      "<p>Hello Alice Smith,</p>\n\n<p>We're reaching out to let you know that we have submitted a request to renew your Epic account with YNHH through the coming term. Because you are returning to your department, your permissions within Epic will not change. If you believe this is an error, or need additional permissions, please contact us by replying to this email.</p>\n\n<p>As a reminder, permissions to access Epic come with great responsibility as you have access to patient PHI. You must adhere to YNHH HIPAA policy and local and state laws when accessing this information. Because you already have an existing Epic account, you will not be required to re-complete Epic training. If you have any questions about this process, do not hesitate to reach out.</p>\n\n<p>Your email: alice@yale.edu</p>\n<p>Your Net ID: as123</p>\n<p>Your Epic ID being renewed is ASMITH.</p>\n<p>Department: Outreach, Triage</p>\n\n<p>If any of this information is incorrect please let us know as soon as possible by replying to this email.</p>\n\n<p>Best,<br>The HAVEN Free Clinic IT Directors</p>",
    );
  });

  // ---------------------------------------------------------------------------
  // epic-onboarding RENEW - no epicId
  // ---------------------------------------------------------------------------

  it("epic-onboarding RENEW no epicId uses 'pending assignment'", async () => {
    const out = await renderEmail(
      "epic-onboarding",
      epicOnboardingContext({
        personName: "Alice Smith",
        netId: "as123",
        contactEmail: "alice@yale.edu",
        epicId: null,
        departmentNames: ["Outreach", "Triage"],
        kind: "RENEW",
      }),
    );
    expect(out.html).toBe(
      "<p>Hello Alice Smith,</p>\n\n<p>We're reaching out to let you know that we have submitted a request to renew your Epic account with YNHH through the coming term. Because you are returning to your department, your permissions within Epic will not change. If you believe this is an error, or need additional permissions, please contact us by replying to this email.</p>\n\n<p>As a reminder, permissions to access Epic come with great responsibility as you have access to patient PHI. You must adhere to YNHH HIPAA policy and local and state laws when accessing this information. Because you already have an existing Epic account, you will not be required to re-complete Epic training. If you have any questions about this process, do not hesitate to reach out.</p>\n\n<p>Your email: alice@yale.edu</p>\n<p>Your Net ID: as123</p>\n<p>Your Epic ID being renewed is pending assignment.</p>\n<p>Department: Outreach, Triage</p>\n\n<p>If any of this information is incorrect please let us know as soon as possible by replying to this email.</p>\n\n<p>Best,<br>The HAVEN Free Clinic IT Directors</p>",
    );
  });

  // ---------------------------------------------------------------------------
  // epic-onboarding NEW - empty departmentNames
  // ---------------------------------------------------------------------------

  it("epic-onboarding NEW empty depts omits department line", async () => {
    const out = await renderEmail(
      "epic-onboarding",
      epicOnboardingContext({
        personName: "Alice Smith",
        netId: "as123",
        contactEmail: "alice@yale.edu",
        epicId: "ASMITH",
        departmentNames: [],
        kind: "NEW",
      }),
    );
    expect(out.html).toBe(
      "<p>Hello Alice Smith,</p>\n\n<p>We're reaching out to let you know that we have submitted a request to create your new Epic account with YNHH for the coming term.</p>\n\n<p>As a reminder, permissions to access Epic come with great responsibility as you have access to patient PHI. You must adhere to YNHH HIPAA policy and local and state laws when accessing this information. If you have any questions about this process, do not hesitate to reach out.</p>\n\n<p>Your email: alice@yale.edu</p>\n<p>Your Net ID: as123</p>\n<p>Your Epic ID: ASMITH</p>\n\n<p>If any of this information is incorrect please let us know as soon as possible by replying to this email.</p>\n\n<p>Best,<br>The HAVEN Free Clinic IT Directors</p>",
    );
  });

  // ---------------------------------------------------------------------------
  // epic-activation
  // ---------------------------------------------------------------------------

  it("epic-activation matches pre-refactor output", async () => {
    const out = await renderEmail(
      "epic-activation",
      epicActivationContext({
        personName: "Alice Smith",
        netId: "as123",
        contactEmail: "alice@yale.edu",
        epicId: "ASMITH",
        departmentNames: ["Outreach", "Triage"],
      }),
    );
    expect(out.subject).toBe("[HAVEN] New Epic Account Set-up");
    expect(out.html).toBe(
      "<p>Hello Alice Smith,</p>\n\n<p><strong>Your new Epic account has been successfully activated by YNHH.</strong></p>\n\n<p>The following email contains your Epic username and instructions for setting up your new account. Please complete the training in order to get editing privileges that should match your directors.</p>\n\n<h3>Please log in to your account within 48 hours, as your access will expire due to inactivity!</h3>\n\n<p>Please call the Help Desk if it has already been 48 hours since your training has been completed if you still don't have editing privileges.</p>\n\n<p>If you have any issues with your access or have issues logging in, you can reply to this email or call the YNHH Help Desk directly at 203-688-4357 (they are available 24/7). If you have trouble logging in on your personal device, try using the Yale VPN or Yale Secure network to access Epic first.</p>\n\n<p>Your Network/Epic ID is: ASMITH</p>\n\n<h2>Instructions for Setting Up Epic Account</h2>\n<ul>\n<li>If you haven't already, please download the Yale VPN at <a href=\"https://studenttechnology.yale.edu/new-students/set-virtual-private-network-vpn\">https://studenttechnology.yale.edu/new-students/set-virtual-private-network-vpn</a>. Some users may find it easier to set up Epic access while using the Yale VPN.</li>\n<li>Click <a href=\"https://passwordreset.ynhh.org/app/portal/\">https://passwordreset.ynhh.org/app/portal/</a> and choose the Log-in option to enter your Epic ID and the temporary password: SecureCare4u#25. Alternatively, you can sign into <a href=\"https://owa.ynhh.org\">https://owa.ynhh.org</a> to reset your temporary password if you are facing issues with the password reset portal.</li>\n<li>Create a new password using the YNHHS password requirements: minimum of 15 characters, at least 1 uppercase letter, 1 lowercase letter, and 1 number; it cannot be one of your last 6 passwords. Passwords expire every 365 days.</li>\n<li>Please write down your password as soon as you create it, so you don't forget it!</li>\n<li>After you create your new password, set up the option to reset your password by YNHHS SMS Password Reset Code in the future by selecting the \"My Details\" tab and adding your mobile phone number. If you don't receive a text message when you attempt to reset your password in the future, please call the Helpdesk at 203-688-4357 to complete the set-up.</li>\n</ul>\n\n<h3>Instructions for Epic Training</h3>\n<ol>\n<li>Close all other browsers and use the Microsoft Edge browser (the preferred browser for the training site) to log in to <a href=\"https://ynhh.certpointsystems.com/\">https://ynhh.certpointsystems.com/</a> with your Epic ID and new password. You may have to turn on the Yale VPN for this step. Note: access to the training system may not be available for 24-48 hours after receiving these instructions; if you encounter difficulties, please attempt to log in again tomorrow. If you are still having trouble accessing the site, please call or email the Helpdesk at <a href=\"mailto:Helpdesk@ynhh.org\">Helpdesk@ynhh.org</a>.</li>\n<li>Once you are logged in, search for the required training in the search engine at the top. The two trainings you need to take are: Epic Ambulatory Chart Review Online Class, and Epic Medical &amp; Advanced Practice Provider Student. If you complete the courses and the course completion status still reads as \"Not Completed\", please log out, close the site, then log in again to refresh.</li>\n<li>Your Epic access will activate at 7 AM the next business day after all training courses are completed. If you complete training on the weekend, your access will not be active until Monday.</li>\n</ol>\n\n<h3>Downloading Epic</h3>\n<ol>\n<li>Download Citrix Receiver (but don't sign into it) at <a href=\"https://www.citrix.com/products/receiver/\">https://www.citrix.com/products/receiver/</a></li>\n<li>Log in through <a href=\"https://myapps.ynhh.org/vpn/index.html\">https://myapps.ynhh.org/vpn/index.html</a>. Make sure you are on the Yale VPN if you are off campus. Bookmark this tab, as you will return to this page every time you want to enter Epic.</li>\n<li>Enter your Epic username and new password.</li>\n<li>Click on the application \"PRD\". Run the \".ica\" file that is automatically downloaded if needed. <strong>You will NOT be able to log into Hyperspace until your training is completed, even though you have changed your password!</strong></li>\n<li>Select the department \"YM HAVEN FREE CLINIC [105370056]\".</li>\n</ol>\n\n<p><strong>Additional Notes:</strong></p>\n<ul>\n<li>Do not select the department \"HAVEN FREE CLINIC\". This is different from \"YM HAVEN FREE CLINIC\".</li>\n<li>Since we are not on DUO, please select the SMS option. You may need to call the Helpdesk and press 1 if you don't receive a text message to reset your password.</li>\n<li>Everything you do and view within the Epic system is automatically tracked and logged for security purposes; to preserve HIPAA confidentiality, you should only view charts pertinent to your role at HAVEN.</li>\n<li>Your password may need to be updated every 60-90 days. You should log into <a href=\"https://passwordreset.ynhh.org/app/portal/\">https://passwordreset.ynhh.org/app/portal/</a> and select \"Change Password\" to create a new one, or you will be prompted within the Epic browser to update it.</li>\n</ul>\n\n<p>Thank you,<br>HAVEN IT &amp; Communications Directors</p>",
    );
  });

  // ---------------------------------------------------------------------------
  // epic-activation - no epicId
  // ---------------------------------------------------------------------------

  it("epic-activation no epicId uses 'pending assignment'", async () => {
    const out = await renderEmail(
      "epic-activation",
      epicActivationContext({
        personName: "Alice Smith",
        epicId: null,
      }),
    );
    expect(out.html).toContain("pending assignment");
  });

  // ---------------------------------------------------------------------------
  // epic-password-reset
  // ---------------------------------------------------------------------------

  it("epic-password-reset matches pre-refactor output", async () => {
    const out = await renderEmail(
      "epic-password-reset",
      epicPasswordResetContext({
        personName: "Alice Smith",
        netId: "as123",
        contactEmail: "alice@yale.edu",
        epicId: "ASMITH",
        departmentNames: ["Outreach", "Triage"],
      }),
    );
    expect(out.subject).toBe("[HAVEN] Epic Account Reset");
    expect(out.html).toBe(
      "<p>Hello Alice Smith,</p>\n\n<p>Your Epic account has been successfully re-activated by YNHH.</p>\n\n<h3>ATTENTION: your password has been reset to \"SecureCare4u#25\" due to inactivity. Please log in to your account within 48 hours, as your access will expire due to inactivity!</h3>\n\n<p>If you have any issues with your access or have issues logging in, you can reply to this email or call the YNHH Help Desk directly at 203-688-4357 (they are available 24/7). If you have trouble logging in on your personal device, try using the Yale VPN or Yale Secure network to access Epic first.</p>\n\n<p>Your Network/Epic ID is: ASMITH<br>\nYour temporary password: <strong>SecureCare4u#25</strong></p>\n\n<ul>\n<li>If you haven't already, please download the Yale VPN at <a href=\"https://studenttechnology.yale.edu/new-students/set-virtual-private-network-vpn\">https://studenttechnology.yale.edu/new-students/set-virtual-private-network-vpn</a>. Some users may find it easier to set up Epic access while using the Yale VPN.</li>\n<li>To reset your password, use <a href=\"https://passwordreset.ynhh.org/app/portal/\">https://passwordreset.ynhh.org/app/portal/</a> and choose the Log-in option to enter your Epic ID and password. Alternatively, you can sign into <a href=\"https://owa.ynhh.org\">https://owa.ynhh.org</a> to reset your password if you are facing issues with the password reset portal.</li>\n<li>Please write down your password as soon as you create it, so you don't forget it!</li>\n</ul>\n\n<h3>Downloading Epic</h3>\n<ol>\n<li>Download Citrix Receiver (but don't sign into it) at <a href=\"https://www.citrix.com/products/receiver/\">https://www.citrix.com/products/receiver/</a></li>\n<li>Log in through <a href=\"https://myapps.ynhh.org/vpn/index.html\">https://myapps.ynhh.org/vpn/index.html</a>. Make sure you are on the Yale VPN if you are off campus. Bookmark this tab, as you will return to this page every time you want to enter Epic.</li>\n<li>Enter your Epic username and new password.</li>\n<li>Click on the application \"PRD\". Run the \".ica\" file that is automatically downloaded if needed. <strong>You will NOT be able to log into Hyperspace until your training is completed, even though you have changed your password!</strong></li>\n<li>Select the department \"YM HAVEN FREE CLINIC [105370056]\".</li>\n</ol>\n\n<p><strong>Additional Notes:</strong></p>\n<ul>\n<li>Do not select the department \"HAVEN FREE CLINIC\". This is different from \"YM HAVEN FREE CLINIC\".</li>\n<li>Since we are not on DUO, please select the SMS option. You may need to call the Helpdesk and press 1 if you don't receive a text message to reset your password.</li>\n<li>Everything you do and view within the Epic system is automatically tracked and logged for security purposes; to preserve HIPAA confidentiality, you should only view charts pertinent to your role at HAVEN.</li>\n<li>Your password may need to be updated every 60-90 days. You should log into <a href=\"https://passwordreset.ynhh.org/app/portal/\">https://passwordreset.ynhh.org/app/portal/</a> and select \"Change Password\" to create a new one, or you will be prompted within the Epic browser to update it.</li>\n</ul>\n\n<p>If you have any questions or concerns, please do not hesitate to reach out by replying to this email.</p>\n\n<p>Thank you,<br>The HAVEN IT &amp; Communications Directors</p>",
    );
  });

  // ---------------------------------------------------------------------------
  // epic-password-reset - no epicId
  // ---------------------------------------------------------------------------

  it("epic-password-reset no epicId uses 'pending assignment'", async () => {
    const out = await renderEmail(
      "epic-password-reset",
      epicPasswordResetContext({
        personName: "Alice Smith",
        epicId: null,
      }),
    );
    expect(out.html).toContain("pending assignment");
    expect(out.html).toBe(
      "<p>Hello Alice Smith,</p>\n\n<p>Your Epic account has been successfully re-activated by YNHH.</p>\n\n<h3>ATTENTION: your password has been reset to \"SecureCare4u#25\" due to inactivity. Please log in to your account within 48 hours, as your access will expire due to inactivity!</h3>\n\n<p>If you have any issues with your access or have issues logging in, you can reply to this email or call the YNHH Help Desk directly at 203-688-4357 (they are available 24/7). If you have trouble logging in on your personal device, try using the Yale VPN or Yale Secure network to access Epic first.</p>\n\n<p>Your Network/Epic ID is: pending assignment<br>\nYour temporary password: <strong>SecureCare4u#25</strong></p>\n\n<ul>\n<li>If you haven't already, please download the Yale VPN at <a href=\"https://studenttechnology.yale.edu/new-students/set-virtual-private-network-vpn\">https://studenttechnology.yale.edu/new-students/set-virtual-private-network-vpn</a>. Some users may find it easier to set up Epic access while using the Yale VPN.</li>\n<li>To reset your password, use <a href=\"https://passwordreset.ynhh.org/app/portal/\">https://passwordreset.ynhh.org/app/portal/</a> and choose the Log-in option to enter your Epic ID and password. Alternatively, you can sign into <a href=\"https://owa.ynhh.org\">https://owa.ynhh.org</a> to reset your password if you are facing issues with the password reset portal.</li>\n<li>Please write down your password as soon as you create it, so you don't forget it!</li>\n</ul>\n\n<h3>Downloading Epic</h3>\n<ol>\n<li>Download Citrix Receiver (but don't sign into it) at <a href=\"https://www.citrix.com/products/receiver/\">https://www.citrix.com/products/receiver/</a></li>\n<li>Log in through <a href=\"https://myapps.ynhh.org/vpn/index.html\">https://myapps.ynhh.org/vpn/index.html</a>. Make sure you are on the Yale VPN if you are off campus. Bookmark this tab, as you will return to this page every time you want to enter Epic.</li>\n<li>Enter your Epic username and new password.</li>\n<li>Click on the application \"PRD\". Run the \".ica\" file that is automatically downloaded if needed. <strong>You will NOT be able to log into Hyperspace until your training is completed, even though you have changed your password!</strong></li>\n<li>Select the department \"YM HAVEN FREE CLINIC [105370056]\".</li>\n</ol>\n\n<p><strong>Additional Notes:</strong></p>\n<ul>\n<li>Do not select the department \"HAVEN FREE CLINIC\". This is different from \"YM HAVEN FREE CLINIC\".</li>\n<li>Since we are not on DUO, please select the SMS option. You may need to call the Helpdesk and press 1 if you don't receive a text message to reset your password.</li>\n<li>Everything you do and view within the Epic system is automatically tracked and logged for security purposes; to preserve HIPAA confidentiality, you should only view charts pertinent to your role at HAVEN.</li>\n<li>Your password may need to be updated every 60-90 days. You should log into <a href=\"https://passwordreset.ynhh.org/app/portal/\">https://passwordreset.ynhh.org/app/portal/</a> and select \"Change Password\" to create a new one, or you will be prompted within the Epic browser to update it.</li>\n</ul>\n\n<p>If you have any questions or concerns, please do not hesitate to reach out by replying to this email.</p>\n\n<p>Thank you,<br>The HAVEN IT &amp; Communications Directors</p>",
    );
  });
});
