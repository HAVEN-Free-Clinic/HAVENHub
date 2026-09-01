import { redirect } from "next/navigation";
import { requireAnyPermission } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { createDraft, assertMayActOnScope } from "@/platform/email/campaigns/service";
import { scopesForPerson } from "@/platform/email/audience/scopes";
import { CAMPAIGN_STARTERS } from "@/platform/email/campaigns/starters";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { Input, Field } from "@/platform/ui/input";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
import { RadioGroup, Radio } from "@/platform/ui/radio";
import { Select } from "@/platform/ui/select";
import { FormActions } from "@/platform/ui/form";

export default async function NewCampaignPage() {
  const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
  const unrestricted = await can(actor.personId, "outreach.send_unrestricted");
  const scopes = await scopesForPerson(actor.personId);

  async function createAction(formData: FormData) {
    "use server";
    const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
    const name = ((formData.get("name") as string | null) ?? "").trim();
    const starterId = ((formData.get("starter") as string | null) ?? "").trim();
    const scopeId = ((formData.get("scopeId") as string | null) ?? "").trim() || null;
    await assertMayActOnScope(actor.personId, scopeId);
    const c = await createDraft(actor.personId, name, {
      starterId: starterId || undefined,
      scopeId,
    });
    redirect(`/outreach/campaigns/${c.id}`);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="New campaign"
        description="Start from a template or a blank draft, then set your audience and send."
      />

      <form action={createAction} className="max-w-md">
        <Card className="space-y-6">
          <Field label="Campaign name">
            <Input
              name="name"
              type="text"
              placeholder="e.g. Spring 2026 reminder"
            />
          </Field>

          <Field label="Audience scope">
            <Select name="scopeId" required={!unrestricted} defaultValue="">
              {unrestricted && <option value="">No scope (everyone)</option>}
              {scopes.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          </Field>
          {!unrestricted && scopes.length === 0 && (
            <Alert tone="warning">
              You have not been granted an audience scope, so you cannot send yet. Ask an
              administrator to grant you one.
            </Alert>
          )}

          <RadioGroup legend="Start from">
            <Radio
              name="starter"
              value=""
              defaultChecked
              className="mt-0.5 self-start"
              label={
                <span className="block">
                  <span className="block font-medium text-foreground">Blank</span>
                  <span className="block text-xs text-muted-foreground">
                    An empty draft you write from scratch.
                  </span>
                </span>
              }
            />
            {CAMPAIGN_STARTERS.map((s) => (
              <Radio
                key={s.id}
                name="starter"
                value={s.id}
                className="mt-0.5 self-start"
                label={
                  <span className="block">
                    <span className="block font-medium text-foreground">{s.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {s.description}
                    </span>
                  </span>
                }
              />
            ))}
          </RadioGroup>

          <p className="text-xs text-muted-foreground">
            Picking a template pre-fills the subject and body &mdash; you can edit
            everything before sending. Leaving the name blank uses the template&rsquo;s
            name.
          </p>

          <FormActions>
            <Button type="submit">Create</Button>
          </FormActions>
        </Card>
      </form>
    </div>
  );
}
