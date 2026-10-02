import { requireModuleAccess } from "@/platform/auth/session";
import { formsForPerson } from "@/modules/forms/service";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Badge } from "@/platform/ui/badge";
import { EmptyState } from "@/platform/ui/empty-state";
import { TextLink } from "@/platform/ui/text-link";
import { DateTime } from "@/platform/dates/display";
import { SetBreadcrumbLeaf } from "@/platform/ui/breadcrumb-context";

export default async function MyFormsPage() {
  const person = await requireModuleAccess("my-info");
  const forms = await formsForPerson(person.personId);

  return (
    <div className="space-y-6">
      <SetBreadcrumbLeaf label="Forms" />
      <PageHeader title="Forms" description="Forms and surveys you have been asked to fill out." />
      <Card>
        {forms.length === 0 ? (
          <EmptyState inline>Nothing to fill out right now.</EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {forms.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div>
                  <TextLink href={`/my-info/forms/${f.id}`} className="font-medium">
                    {f.title}
                  </TextLink>
                  {f.submittedAt === null && f.accepting && f.closesAt && (
                    <p className="text-xs text-muted-foreground">
                      Due <DateTime value={f.closesAt} />
                    </p>
                  )}
                </div>
                {f.submittedAt ? (
                  <Badge tone="success">Done</Badge>
                ) : f.accepting ? (
                  <Badge tone="brand">To do</Badge>
                ) : (
                  <Badge tone="default">Closed</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
