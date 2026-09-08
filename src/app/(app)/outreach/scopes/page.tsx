import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { listScopes, createScope } from "@/platform/email/audience/scopes";
import { EMPTY_AUDIENCE } from "@/platform/email/audience/types";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { Input, Field } from "@/platform/ui/input";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { EmptyState } from "@/platform/ui/empty-state";
import { TextLink } from "@/platform/ui/text-link";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";

export default async function ScopesPage() {
  await requirePermission("outreach.manage_scopes");
  const scopes = await listScopes();

  async function createAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("outreach.manage_scopes");
    const name = ((formData.get("name") as string | null) ?? "").trim();
    // A new scope starts EMPTY, which compiles to match-nobody. The admin then
    // builds it up on the detail page. Starting empty rather than
    // match-everyone is deliberate: an unfinished send boundary must be closed.
    const scope = await createScope(actor.personId, {
      name,
      audience: EMPTY_AUDIENCE,
    });
    redirect(`/outreach/scopes/${scope.id}`);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audience scopes"
        description="Named audiences you can grant to a person or role. A campaign sent under a scope can only narrow it."
      />

      <form action={createAction} className="max-w-md">
        <Card className="space-y-4">
          <Field label="New scope name">
            <Input name="name" type="text" placeholder="e.g. Pediatrics outreach" required />
          </Field>
          <FormActions>
            <Button type="submit">Create</Button>
          </FormActions>
        </Card>
      </form>

      {scopes.length === 0 ? (
        <EmptyState
          title="No scopes yet"
          description="A sender with no granted scope can email nobody."
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Scope</TH>
              <TH>Conditions</TH>
            </TR>
          </THead>
          <tbody>
            {scopes.map((s) => (
              <TR key={s.id}>
                <TD>
                  <TextLink href={`/outreach/scopes/${s.id}`} className="font-medium">
                    {s.name}
                  </TextLink>
                </TD>
                <TD className="tabular-nums text-muted-foreground">
                  {s.audience.conditions.length}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
