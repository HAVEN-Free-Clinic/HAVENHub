import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { hubTrail } from "@/platform/ui/breadcrumb-trail";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Checkbox } from "@/platform/ui/checkbox";
import { EmptyState } from "@/platform/ui/empty-state";
import { Field, Input, ReadonlyField, Textarea } from "@/platform/ui/input";
import { PageHeader } from "@/platform/ui/page-header";
import { Radio, RadioGroup } from "@/platform/ui/radio";
import { SectionHeader } from "@/platform/ui/section-header";
import { Select } from "@/platform/ui/select";
import { Skeleton } from "@/platform/ui/skeleton";
import { Spinner } from "@/platform/ui/spinner";
import { StatCard } from "@/platform/ui/stat-card";
import { TabRow, type TabItem } from "@/platform/ui/tab-row";
import { LoadingButtonDemo, MorphDialogDemo, ToastDemo } from "./design-demos";

/**
 * The design reference: every shared primitive in its states, plus live demos
 * of the motion system (morphing dialog, sliding tab indicator, toasts). Not
 * in the nav; it is for whoever is building or reviewing UI. Flip the theme
 * from the account menu to check dark mode, and turn on the OS reduced-motion
 * setting to check that everything still works without movement.
 *
 * Composed only from platform/ui, so a primitive that changes shows up here
 * changed, and a primitive missing from here is one nobody can review.
 */

type PageProps = { searchParams: Promise<{ tab?: string; view?: string }> };

const TABS: TabItem[] = [
  { label: "Overview", href: "/design?tab=overview" },
  { label: "Members", href: "/design?tab=members", badge: 12 },
  { label: "Settings", href: "/design?tab=settings" },
];

const VIEWS: TabItem[] = [
  { label: "Week", href: "/design?view=week" },
  { label: "Month", href: "/design?view=month" },
  { label: "List", href: "/design?view=list" },
];

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <SectionHeader level="title">{title}</SectionHeader>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

export default async function DesignPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const tab = sp.tab ?? "overview";
  const view = sp.view ?? "week";

  return (
    <div className="space-y-10">
      <SetBreadcrumb trail={hubTrail({ label: "Design" })} />
      <PageHeader
        title="Design system"
        description="Every shared component in its states, and the motion that ties them together."
        status={<Badge tone="brand">Reference</Badge>}
      />

      <Section title="Motion" description="Springs with no bounce, short distances, a light blur when content swaps.">
        <Card className="space-y-5">
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Morphing dialog</p>
            <p className="text-sm text-muted-foreground">
              One dialog, many steps. The height follows each step and content slides in the direction of travel. On a
              phone it opens as a bottom sheet you can drag down to close.
            </p>
            <MorphDialogDemo />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Sliding tab indicator</p>
            <p className="text-sm text-muted-foreground">Switch tabs; the indicator glides rather than jumps.</p>
            <TabRow items={TABS} label="Demo sections" isActive={(i) => i.href === `/design?tab=${tab}`} />
            <TabRow
              items={VIEWS}
              label="Demo views"
              variant="segmented"
              isActive={(i) => i.href === `/design?view=${view}`}
            />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Toasts</p>
            <p className="text-sm text-muted-foreground">They rise in, and the stack glides into the gap one leaves.</p>
            <ToastDemo />
          </div>
        </Card>
      </Section>

      <Section title="Buttons" description="Press any of them: they settle at 97% and spring back.">
        <Card className="space-y-4">
          <Row>
            <Button>Primary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
          </Row>
          <Row>
            <Button size="sm">Small</Button>
            <Button>Medium</Button>
            <Button size="lg">Large</Button>
          </Row>
          <Row>
            <Button disabled>Disabled</Button>
            <Button variant="outline" disabled>
              Disabled outline
            </Button>
            <LoadingButtonDemo />
          </Row>
          <div className="rounded-xl bg-brand p-4">
            <Button variant="inverse">Inverse, on brand</Button>
          </div>
        </Card>
      </Section>

      <Section title="Form controls">
        <Card className="grid gap-5 md:grid-cols-2">
          <Field label="Name" hint="As it should appear on your badge.">
            <Input name="d-name" placeholder="Sam Rivera" />
          </Field>
          <Field label="Email" required error="Enter an email address.">
            <Input name="d-email" type="email" aria-invalid />
          </Field>
          <Field label="Department">
            <Select name="d-dept" defaultValue="">
              <option value="" disabled>
                Choose one
              </option>
              <option>Clinical</option>
              <option>Operations</option>
            </Select>
          </Field>
          <Field label="Disabled">
            <Input name="d-disabled" disabled value="Read only for now" readOnly />
          </Field>
          <ReadonlyField label="On file" value="sam.rivera@yale.edu" hint="A static row, not a disabled input." />
          <Field label="Notes">
            <Textarea name="d-notes" rows={3} placeholder="Anything the director should know" />
          </Field>
          <div className="space-y-1">
            <Checkbox name="d-c1" label="Remind me by email" defaultChecked />
            <Checkbox name="d-c2" label="Unchecked" />
            <Checkbox name="d-c3" label="Some selected" indeterminate />
            <Checkbox name="d-c4" label="Disabled" disabled />
          </div>
          <RadioGroup>
            <Radio name="d-r" value="a" label="Returning volunteer" defaultChecked />
            <Radio name="d-r" value="b" label="New volunteer" />
          </RadioGroup>
        </Card>
      </Section>

      <Section title="Surfaces" description="Interactive cards lift their shadow on hover; nothing moves.">
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <p className="text-sm font-medium text-foreground">Card</p>
            <p className="mt-1 text-sm text-muted-foreground">The default content surface.</p>
          </Card>
          <Card interactive>
            <p className="text-sm font-medium text-foreground">Interactive card</p>
            <p className="mt-1 text-sm text-muted-foreground">Hover me.</p>
          </Card>
          <Card size="compact">
            <p className="text-sm font-medium text-foreground">Compact</p>
            <p className="mt-1 text-sm text-muted-foreground">Dense rows and nested panels.</p>
          </Card>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <StatCard label="Active volunteers" value={128} />
          <StatCard label="Cleared" value={96} tone="success" />
          <StatCard label="Expiring soon" value={7} tone="warning" />
        </div>
      </Section>

      <Section title="Status">
        <Card className="space-y-4">
          <Row>
            <Badge>Default</Badge>
            <Badge tone="brand">Brand</Badge>
            <Badge tone="success">Cleared</Badge>
            <Badge tone="warning">Expiring</Badge>
            <Badge tone="critical">Blocked</Badge>
            <Badge count>3</Badge>
          </Row>
          <div className="space-y-2">
            <Alert tone="info">Your draft is kept for next time.</Alert>
            <Alert tone="success">Application received.</Alert>
            <Alert tone="warning">Your HIPAA certificate expires in 14 days.</Alert>
            <Alert tone="error">We could not save that. Check your connection and try again.</Alert>
          </div>
        </Card>
      </Section>

      <Section title="Loading and empty">
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="space-y-3">
            <Row>
              <Spinner size="sm" />
              <Spinner />
              <Spinner size="lg" />
            </Row>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-24 w-full" />
          </Card>
          <EmptyState
            bordered
            icon={Inbox}
            title="No notifications yet"
            description="When a director assigns you a shift, it shows up here."
            action={<Button size="sm">Browse shifts</Button>}
          />
        </div>
      </Section>
    </div>
  );
}
