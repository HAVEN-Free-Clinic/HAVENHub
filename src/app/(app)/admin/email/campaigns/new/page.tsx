import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { createDraft } from "@/platform/email/campaigns/service";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { Input } from "@/platform/ui/input";

export default async function NewCampaignPage() {
  await requirePermission("admin.send_email_campaign");

  async function createAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.send_email_campaign");
    const name = ((formData.get("name") as string | null) ?? "").trim();
    const c = await createDraft(actor.personId, name || "Untitled campaign");
    redirect(`/admin/email/campaigns/${c.id}`);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="New campaign"
        description="Give your campaign a name to get started."
      />

      <form action={createAction} className="max-w-sm space-y-4">
        <div>
          <label className="block text-sm font-medium text-foreground-soft" htmlFor="name">
            Campaign name
          </label>
          <Input
            id="name"
            name="name"
            type="text"
            placeholder="e.g. Spring 2026 reminder"
            required
            className="mt-1"
          />
        </div>
        <Button type="submit">Create</Button>
      </form>
    </div>
  );
}
