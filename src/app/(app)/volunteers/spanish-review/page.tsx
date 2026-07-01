import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { listSpanishReviewQueue, recordSpanishAssessment } from "@/platform/spanish-review";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Button } from "@/platform/ui/button";

export default async function SpanishReviewPage() {
  await requirePermission("volunteers.verify_spanish");
  const rows = await listSpanishReviewQueue();

  async function assessAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.verify_spanish");
    const personId = formData.get("personId") as string;
    const verified = formData.get("verified") === "true";
    await recordSpanishAssessment(actor.personId, personId, verified);
    revalidatePath("/volunteers/spanish-review");
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Spanish review"
        description="Volunteers who self-reported speaking Spanish and are awaiting an interpreting-department assessment. Verifying counts them as a Spanish provider for scheduling."
      />
      {rows.length === 0 ? (
        <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
          No one is awaiting Spanish review.
        </Card>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>NetID</TH>
              <TH>Email</TH>
              <TH>Assessment</TH>
            </TR>
          </THead>
          <tbody>
            {rows.map((p) => (
              <TR key={p.id}>
                <TD className="font-medium">{p.name}</TD>
                <TD className="text-muted-foreground">
                  {p.netId ?? <span className="text-subtle-foreground">-</span>}
                </TD>
                <TD className="text-muted-foreground">
                  {p.contactEmail ?? <span className="text-subtle-foreground">-</span>}
                </TD>
                <TD>
                  <div className="flex gap-2">
                    <form action={assessAction}>
                      <input type="hidden" name="personId" value={p.id} />
                      <input type="hidden" name="verified" value="true" />
                      <Button type="submit" variant="primary" size="sm">Verify</Button>
                    </form>
                    <form action={assessAction}>
                      <input type="hidden" name="personId" value={p.id} />
                      <input type="hidden" name="verified" value="false" />
                      <Button type="submit" variant="outline" size="sm">Not verified</Button>
                    </form>
                  </div>
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
