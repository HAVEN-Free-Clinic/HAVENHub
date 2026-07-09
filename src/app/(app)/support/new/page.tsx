import { redirect } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { prisma } from "@/platform/db";
import { createTechRequest, SupportForbiddenError, SupportStateError } from "@/modules/support/services/tech-request";
import { notifyTicketSubmitted } from "@/modules/support/services/notifications";
import { persistAttachment } from "@/modules/support/services/attachments";
import { SubmitForm } from "@/modules/support/components/submit-form";
import type { TechRequestCategory, EpicRequestKind } from "@prisma/client";

type PageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function SubmitPage({ searchParams }: PageProps) {
  await requireModuleAccess("support");
  const sp = await searchParams;

  async function submitAction(formData: FormData) {
    "use server";
    const session = await requireModuleAccess("support");
    const category = formData.get("category") as TechRequestCategory;

    let req;
    try {
      req = await createTechRequest(session.personId, {
        category,
        subject: (formData.get("subject") as string) ?? "",
        description: (formData.get("description") as string) ?? "",
        epicSubtype: (formData.get("epicSubtype") as EpicRequestKind) || null,
        epicJobTitle: (formData.get("epicJobTitle") as string) || null,
        epicMirrorId: (formData.get("epicMirrorId") as string) || null,
        worksAtYnhh: formData.get("worksAtYnhh") === "on",
        govId: (formData.get("govId") as string) || null,
        netId: (formData.get("netId") as string) || null,
      });
    } catch (err) {
      if (err instanceof SupportStateError) {
        redirect(`/support/new?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }

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

    const requester = await prisma.person.findUniqueOrThrow({
      where: { id: session.personId },
      select: { id: true, name: true, entraObjectId: true, contactEmail: true },
    });
    await notifyTicketSubmitted(prisma, req, requester);
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
