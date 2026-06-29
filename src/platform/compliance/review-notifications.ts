import type { Prisma, PrismaClient } from "@prisma/client";
import { getSetting } from "@/platform/settings/service";
import { peopleWithAnyPermission } from "@/platform/rbac/holders";
import { notify } from "@/platform/notifications/notify";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { complianceDateReviewContext } from "@/platform/email/templates/compliance";

type Db = PrismaClient | Prisma.TransactionClient;

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
    console.warn(
      `[compliance] ${volunteer.name} (${volunteer.id}) uploaded a certificate without a parsed completion date, but no compliance manager exists to review it.`,
    );
    return 0;
  }

  const baseUrl = await getSetting<string>("app.baseUrl");
  const reviewLink = `${baseUrl}/volunteers/master`;
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
