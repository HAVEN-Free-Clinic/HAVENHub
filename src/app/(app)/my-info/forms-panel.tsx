import { Card } from "@/platform/ui/card";
import { Badge } from "@/platform/ui/badge";
import { TextLink } from "@/platform/ui/text-link";
import type { PersonFormRow } from "@/modules/forms/service";

/** My Info's short list of assigned forms: anything still to do, then a link to all of them. */
export function MyFormsPanel({ forms }: { forms: PersonFormRow[] }) {
  const todo = forms.filter((f) => f.submittedAt === null && f.accepting);
  return (
    <Card className="space-y-3">
      {todo.length > 0 ? (
        <ul className="space-y-2">
          {todo.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2">
              <TextLink href={`/my-info/forms/${f.id}`} className="font-medium">
                {f.title}
              </TextLink>
              <Badge tone="brand">To do</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-foreground-soft">You are all caught up.</p>
      )}
      <TextLink href="/my-info/forms" className="text-sm">
        All my forms
      </TextLink>
    </Card>
  );
}
