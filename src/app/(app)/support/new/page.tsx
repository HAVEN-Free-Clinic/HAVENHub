import { redirect } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { prisma } from "@/platform/db";
import { createTechRequest, SupportForbiddenError, SupportStateError } from "@/modules/support/services/tech-request";
import { notifyTicketSubmitted } from "@/modules/support/services/notifications";
import { persistAttachment } from "@/modules/support/services/attachments";
import { SubmitForm } from "@/modules/support/components/submit-form";
import { captureEvent } from "@/platform/posthog/capture";
import { activeTermGroup } from "@/platform/posthog/groups";
import { ALL_CATEGORIES } from "@/modules/support/filter-options";
import type { TechRequestCategory } from "@prisma/client";

type PageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function SubmitPage({ searchParams }: PageProps) {
  await requireModuleAccess("support");
  const sp = await searchParams;

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

  return (
    <>
      <PageHeader
        title="Submit a request"
        description="Tell IT what you need. You can track it under My requests."
      />
      <div className="mt-8">
        <SubmitForm action={submitAction} error={sp.error ? decodeURIComponent(sp.error) : undefined} />
      </div>
    </>
  );
}
