import Link from "next/link";
import { requireModuleAccess } from "@/platform/auth/session";
import { listAttendings, CAPABILITY_KEYS, CAPABILITY_LABELS } from "@/modules/schedule/services/attendings";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { buttonClasses } from "@/platform/ui/button";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";

export default async function AttendingsListPage() {
  await requireModuleAccess("schedule");
  const attendings = await listAttendings();

  return (
    <div className="space-y-6">
      <PageHeader title="RHD Attendings" />
      <div>
        <Link href="/schedule/attendings/new" className={buttonClasses("primary", "sm")}>
          Add attending
        </Link>
      </div>
      {attendings.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface px-6 py-10 text-center text-sm text-muted-foreground">
          No attendings yet.
        </div>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              {CAPABILITY_KEYS.map((k) => (
                <TH key={k}>{CAPABILITY_LABELS[k]}</TH>
              ))}
              <TH>Active</TH>
              <TH></TH>
            </TR>
          </THead>
          <tbody>
            {attendings.map((a) => (
              <TR key={a.id}>
                <TD>
                  <span className="font-medium text-foreground">{a.scheduleName}</span>
                  <span className="block text-xs text-subtle-foreground">{a.fullName}</span>
                </TD>
                {CAPABILITY_KEYS.map((k) => (
                  <TD key={k} className="text-muted-foreground text-xs">{a[k] as string}</TD>
                ))}
                <TD>{a.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="default">Inactive</Badge>}</TD>
                <TD>
                  <Link href={`/schedule/attendings/${a.id}`} className="text-brand-fg hover:underline text-sm">Edit</Link>
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
