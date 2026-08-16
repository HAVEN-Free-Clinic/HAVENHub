import { redirect } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { prisma } from "@/platform/db";
import { isIntercomConfigured } from "@/platform/intercom/config";
import { AskInMessengerButton } from "@/platform/intercom/messenger-actions";
import { createTechRequest, SupportForbiddenError, SupportStateError } from "@/modules/support/services/tech-request";
import { notifyTicketSubmitted } from "@/modules/support/services/notifications";
import { persistAttachment } from "@/modules/support/services/attachments";
import { SubmitForm } from "@/modules/support/components/submit-form";
import { captureEvent } from "@/platform/posthog/capture";
import { activeTermGroup } from "@/platform/posthog/groups";
import { ALL_CATEGORIES } from "@/modules/support/filter-options";
import type { TechRequestCategory } from "@prisma/client";

export default async function SubmitPage() {
  await requireModuleAccess("support");

  async function submitAction(formData: FormData) {
    "use server";
    const session = await requireModuleAccess("support");
    // Validate the category against the enum before it reaches Prisma. Every other
    // enum input in the module is checked this way; without it a crafted POST with
    // a bad category throws an uncaught PrismaClientValidationError.
    const rawCategory = String(formData.get("category") ?? "");
    if (!(ALL_CATEGORIES as string[]).includes(rawCategory)) {
      redirect(`/support/new?error=${encodeURIComponent("Choose a valid category.")}`);
    }
    const category = rawCategory as TechRequestCategory;

    let req;
    try {
      req = await createTechRequest(session.personId, {
        category,
        subject: (formData.get("subject") as string) ?? "",
        description: (formData.get("description") as string) ?? "",
      });
    } catch (err) {
      if (err instanceof SupportStateError) {
        redirect(`/support/new?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }

    // Alert managers and confirm to the requester as soon as the ticket exists,
    // before persisting attachments. An attachment failure below redirects
    // (throws NEXT_REDIRECT), so notifying here keeps a committed ticket from
    // ever going un-triaged just because one file was oversized or disallowed.
    const requester = await prisma.person.findUniqueOrThrow({
      where: { id: session.personId },
      select: { id: true, name: true, entraObjectId: true, contactEmail: true },
    });
    await notifyTicketSubmitted(prisma, req, requester);

    const files = formData.getAll("attachments").filter((f): f is File => f instanceof File && f.size > 0);
    try {
      for (const file of files) {
        await persistAttachment(session.personId, { requestId: req.id }, {
          fileName: file.name,
          mimeType: file.type,
          bytes: Buffer.from(await file.arrayBuffer()),
        });
      }
    } catch (err) {
      if (err instanceof SupportForbiddenError) {
        redirect(`/support/${req.id}?submitted=1&attachmentError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }

    await captureEvent({
      distinctId: session.personId,
      event: "support_request_submitted",
      properties: { category, request_id: req.id, has_attachments: files.length > 0 },
      groups: await activeTermGroup(),
    });
    redirect(`/support/${req.id}?submitted=1`);
  }

  // Chat is where support conversations actually happen now (see the design
  // doc's "Where the work happens"), so when Intercom is configured this
  // page's only job is to open the Messenger -- one path in, not a form
  // sitting next to a competing "or chat instead" link.
  //
  // The form is not deleted, only reached a different way: unset
  // NEXT_PUBLIC_INTERCOM_APP_ID (an ops lever, no deploy) and this branch
  // falls through to it below. That is the fallback intake path for an
  // Intercom outage, when chat cannot reach anyone at all -- an intake path
  // that only exists inside a third party means no support intake at all
  // during one.
  if (isIntercomConfigured()) {
    return (
      <>
        <PageHeader title="Get help" description="Chat with IT Support to get help or ask a question." />
        <div className="mt-8">
          <Card className="flex flex-col items-start gap-4">
            <p className="text-sm text-muted-foreground">
              Start a conversation in the Messenger and an IT Support agent will pick it up from there.
            </p>
            <AskInMessengerButton variant="primary">Ask in Messenger</AskInMessengerButton>
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Submit a request"
        description="Tell IT what you need. You can track it under My requests."
      />
      <div className="mt-8">
        <SubmitForm action={submitAction} />
      </div>
    </>
  );
}
