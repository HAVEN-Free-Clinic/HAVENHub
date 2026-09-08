import { notFound, redirect } from "next/navigation";
import { ActiveBadge } from "@/platform/ui/active-badge";
import { requireModuleAccess } from "@/platform/auth/session";
import {
  getAttending,
  updateAttending,
  canManageAttendings,
  listSpecialties,
  capabilitiesForSpecialty,
  capabilitiesFromFormData,
  AttendingValidationError,
  AttendingForbiddenError,
} from "@/modules/schedule/services/attendings";
import {
  enableHubAccess,
  disableHubAccess,
  hubAccessState,
} from "@/modules/schedule/services/attending-access";
import { AttendingForm } from "@/modules/schedule/components/attending-form";
import { Badge } from "@/platform/ui/badge";
import { Card } from "@/platform/ui/card";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Button } from "@/platform/ui/button";
import { SectionHeader } from "@/platform/ui/section-header";
import { PageHeader } from "@/platform/ui/page-header";
import { revalidatePath } from "next/cache";
import { SetBreadcrumbLeaf } from "@/platform/ui/breadcrumb-context";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function EditAttendingPage({ params }: PageProps) {
  const session = await requireModuleAccess("schedule");
  const { id } = await params;

  if (!(await canManageAttendings(session.personId))) redirect("/no-access");

  const attending = await getAttending(id);
  if (!attending) notFound();

  const [specialties, capabilities] = await Promise.all([
    listSpecialties(),
    capabilitiesForSpecialty(attending.specialtyId),
  ]);

  async function updateAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    try {
      await updateAttending(actor.personId, id, {
        scheduleName: (formData.get("scheduleName") as string) ?? "",
        fullName: (formData.get("fullName") as string) ?? "",
        credentials: (formData.get("credentials") as string) || null,
        specialtyId: (formData.get("specialtyId") as string) || null,
        email: (formData.get("email") as string) || null,
        phone: (formData.get("phone") as string) || null,
        notes: (formData.get("notes") as string) || null,
        capabilities: capabilitiesFromFormData(formData),
        isActive: formData.get("isActive") === "on",
      });
    } catch (err) {
      if (err instanceof AttendingValidationError || err instanceof AttendingForbiddenError) {
        redirect(`/schedule/attendings/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect("/schedule/attendings");
  }

  async function enableAccessAction() {
    "use server";
    const actor = await requireModuleAccess("schedule");
    let result;
    try {
      result = await enableHubAccess(actor.personId, id);
    } catch (err) {
      if (err instanceof AttendingValidationError || err instanceof AttendingForbiddenError) {
        redirect(`/schedule/attendings/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath(`/schedule/attendings/${id}`);
    revalidatePath("/schedule/attendings");
    if (result.outcome === "skipped") {
      redirect(`/schedule/attendings/${id}?error=${encodeURIComponent(result.reason)}`);
    }
    redirect(`/schedule/attendings/${id}?message=${encodeURIComponent("Hub access enabled. They have been emailed.")}`);
  }

  async function disableAccessAction() {
    "use server";
    const actor = await requireModuleAccess("schedule");
    try {
      await disableHubAccess(actor.personId, id);
    } catch (err) {
      if (err instanceof AttendingValidationError || err instanceof AttendingForbiddenError) {
        redirect(`/schedule/attendings/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath(`/schedule/attendings/${id}`);
    revalidatePath("/schedule/attendings");
    redirect(`/schedule/attendings/${id}?message=${encodeURIComponent("Hub access revoked.")}`);
  }

  const access = hubAccessState(attending);

  return (
    <div className="space-y-6">
      <SetBreadcrumbLeaf label={attending.scheduleName} />
      <PageHeader
        title={attending.scheduleName}
        description={attending.fullName}
        status={<ActiveBadge active={attending.isActive} />}
      />
      {/* updateAction redirects here with ?error= on a domain failure. */}
      {/* No inline Alert: FlashReader claims this param, toasts it, and strips it
          from the URL, so an inline branch reported it twice and then lost its
          value on the router.replace. Error toasts do not auto-dismiss. */}

      <AttendingForm
        action={updateAction}
        mode="edit"
        attending={attending}
        specialties={specialties}
        selectedSpecialtyId={attending.specialtyId}
        capabilities={capabilities}
        values={attending.capabilityValues}
      />

      {/* Hub access, BELOW the roster form. This route is the attending's own
          page, so the record's own fields come first; access is a separate act
          performed on the record above it, and the "add an email address above"
          branch below only reads correctly in that order.

          Kept out of AttendingForm on purpose: the form is a
          replace-set save of the roster record, and access is a separate act with
          its own audit entry, its own email, and a consequence (a login) that must
          not ride along on an unrelated field edit. */}
      <Card>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <SectionHeader as="h2" level="title" className="text-base">Hub access</SectionHeader>
          {access.personId ? <Badge tone="brand">Enabled</Badge> : <Badge>Not enabled</Badge>}
        </div>
        <p className="text-sm text-subtle-foreground mb-4">
          {access.personId ? (
            <>
              {attending.scheduleName} can sign in to see their schedule, set the dates they can cover, and
              request swaps and drops.{" "}
              {access.signInMethod === "yale-sso"
                ? "They sign in with their Yale account."
                : "They sign in with an emailed link."}
            </>
          ) : access.blockedReason ? (
            <>
              {access.blockedReason} Add an email address above and save before enabling access.
            </>
          ) : (
            <>
              Enabling creates their Hub account, emails them, and lets them manage their own schedule.{" "}
              {access.signInMethod === "yale-sso"
                ? "They will sign in with their Yale account."
                : "They will sign in with an emailed link."}
            </>
          )}
        </p>
        {access.personId ? (
          <form action={disableAccessAction}>
            <ConfirmButton
              label="Revoke access"
              confirmLabel="Revoke this attending's Hub access? Their schedule is not affected."
            />
          </form>
        ) : (
          <form action={enableAccessAction}>
            <Button type="submit" disabled={!!access.blockedReason}>Enable Hub access</Button>
          </form>
        )}
      </Card>

    </div>
  );
}
