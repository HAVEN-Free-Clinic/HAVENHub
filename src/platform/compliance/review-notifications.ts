import { type Db } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { peopleWithAnyPermission } from "@/platform/rbac/holders";
import { notify } from "@/platform/notifications/notify";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import {
  complianceDateReviewContext,
  complianceVerificationReviewContext,
  complianceCertVerifiedContext,
  complianceCertRejectedContext,
} from "@/platform/email/templates/compliance";
import { log } from "@/platform/logging";


/** Permissions that allow a person to set a certificate completion date
 *  (see compliance.setCompletionDateAsManager). "*" holders match implicitly. */
const CAN_SET_COMPLETION_DATE = ["volunteers.manage_compliance", "admin.access"];

/**
 * Alert the people who can resolve it that a volunteer's HIPAA certificate was
 * saved without a machine-readable completion date, so the manual-verification
 * queue is actually driven instead of relying on someone scanning the roster.
 *
 * Recipients are everyone who can call setCompletionDateAsManager (compliance
 * managers and admins), minus the volunteer themselves. Dispatched through the
 * unified notify() pipeline (email/Teams/inbox per admin channel settings) on
 * the provided Db handle. Returns the number of people notified.
 */
export async function notifyDatelessCertReview(
  db: Db,
  volunteer: { id: string; name: string },
): Promise<number> {
  const recipients = (await peopleWithAnyPermission(CAN_SET_COMPLETION_DATE)).filter(
    (p) => p.id !== volunteer.id,
  );
  if (recipients.length === 0) {
    log.warn(
      `[compliance] ${volunteer.name} (${volunteer.id}) uploaded a certificate without a parsed completion date, but no compliance manager exists to review it.`,
      { volunteerId: volunteer.id },
    );
    return 0;
  }

  const baseUrl = await getSetting<string>("app.baseUrl");
  const reviewLink = `${baseUrl}/volunteers`;
  const rendered = await renderEmail(
    "compliance-date-review",
    complianceDateReviewContext({ volunteerName: volunteer.name, reviewLink }),
  );

  for (const recipient of recipients) {
    await notify(db, {
      type: "compliance-date-review",
      person: {
        id: recipient.id,
        entraObjectId: recipient.entraObjectId,
        contactEmail: recipient.contactEmail,
      },
      email: { subject: rendered.subject, html: rendered.html },
      teams: {
        title: "HIPAA certificate needs a completion date",
        summary: `${volunteer.name} uploaded a HIPAA certificate without a readable completion date. Please review it and set the date.`,
        link: reviewLink,
      },
      triggeredById: volunteer.id,
    });
  }

  return recipients.length;
}

/**
 * Alert the people who can verify it that a volunteer's HIPAA certificate was
 * saved WITH a machine-readable completion date but is still unverified
 * (PENDING_VERIFICATION), which blocks the volunteer until a manager verifies it.
 * Without this the verification queue was never driven: only the parse-failure
 * (dateless) case notified anyone, so a successfully-parsed cert sat silently.
 *
 * Recipients are everyone who can verify a certificate (compliance managers and
 * admins), minus the volunteer themselves. Returns the number of people notified.
 */
export async function notifyCertNeedsVerification(
  db: Db,
  volunteer: { id: string; name: string },
): Promise<number> {
  const recipients = (await peopleWithAnyPermission(CAN_SET_COMPLETION_DATE)).filter(
    (p) => p.id !== volunteer.id,
  );
  if (recipients.length === 0) {
    log.warn(
      `[compliance] ${volunteer.name} (${volunteer.id}) uploaded a certificate awaiting verification, but no compliance manager exists to verify it.`,
      { volunteerId: volunteer.id },
    );
    return 0;
  }

  const baseUrl = await getSetting<string>("app.baseUrl");
  const reviewLink = `${baseUrl}/volunteers`;
  const rendered = await renderEmail(
    "compliance-verification-review",
    complianceVerificationReviewContext({ volunteerName: volunteer.name, reviewLink }),
  );

  for (const recipient of recipients) {
    await notify(db, {
      type: "compliance-verification-review",
      person: {
        id: recipient.id,
        entraObjectId: recipient.entraObjectId,
        contactEmail: recipient.contactEmail,
      },
      email: { subject: rendered.subject, html: rendered.html },
      teams: {
        title: "HIPAA certificate awaiting verification",
        summary: `${volunteer.name} uploaded a HIPAA certificate that needs to be verified before they can be cleared.`,
        link: reviewLink,
      },
      triggeredById: volunteer.id,
    });
  }

  return recipients.length;
}

/**
 * Tell a volunteer their HIPAA certificate has been verified.
 *
 * The two helpers above notify managers that something needs their attention.
 * This one closes the loop back: until a manager verifies, the onboarding gate
 * blocks the member from every page, and before this existed the only way to
 * learn they were cleared was to keep signing in and checking.
 */
export async function notifyCertVerified(
  db: Db,
  volunteer: { id: string; name: string; entraObjectId: string | null; contactEmail: string | null },
): Promise<void> {
  const baseUrl = await getSetting<string>("app.baseUrl");
  const myInfoLink = `${baseUrl}/my-info`;
  const rendered = await renderEmail(
    "compliance-cert-verified",
    complianceCertVerifiedContext({ volunteerName: volunteer.name, myInfoLink }),
  );

  await notify(db, {
    type: "compliance-cert-verified",
    person: {
      id: volunteer.id,
      entraObjectId: volunteer.entraObjectId,
      contactEmail: volunteer.contactEmail,
    },
    email: { subject: rendered.subject, html: rendered.html },
    teams: {
      title: "Your HIPAA certificate is verified",
      summary: "A compliance manager confirmed your HIPAA certificate. Nothing further is needed for this requirement.",
      link: myInfoLink,
    },
  });
}


/**
 * Tell a volunteer their HIPAA certificate was refused, and what to do instead.
 *
 * This is the whole point of rejecting rather than deleting. A deleted
 * certificate leaves the member reading "Not uploaded" for a file they know they
 * uploaded, so they upload the same wrong PDF again and the clinic learns
 * nothing; a rejected one names the problem while the file is still on the
 * record. The explanation is built by rejectionExplanation() upstream, so the
 * email and the HIPAA panel cannot end up telling the same member two different
 * things about the same certificate.
 *
 * Like notifyCertVerified, this runs after the rejection is durably committed
 * and audited: a notification failure must never surface to the manager as a
 * failed rejection.
 */
export async function notifyCertRejected(
  db: Db,
  volunteer: { id: string; name: string; entraObjectId: string | null; contactEmail: string | null },
  rejection: { explanation: string; reasonLabel: string },
): Promise<void> {
  const baseUrl = await getSetting<string>("app.baseUrl");
  const myInfoLink = `${baseUrl}/my-info`;
  const rendered = await renderEmail(
    "compliance-cert-rejected",
    complianceCertRejectedContext({
      volunteerName: volunteer.name,
      explanation: rejection.explanation,
      myInfoLink,
    }),
  );

  await notify(db, {
    type: "compliance-cert-rejected",
    person: {
      id: volunteer.id,
      entraObjectId: volunteer.entraObjectId,
      contactEmail: volunteer.contactEmail,
    },
    email: { subject: rendered.subject, html: rendered.html },
    teams: {
      title: "Your HIPAA certificate was not accepted",
      // The reason label rather than the full explanation: a Teams card summary
      // is one line, and the member gets the detail the moment they follow the
      // link to My Info, where the same sentence is on the panel.
      summary: `${rejection.reasonLabel}. Please upload the correct certificate in HAVEN Hub.`,
      link: myInfoLink,
    },
  });
}
