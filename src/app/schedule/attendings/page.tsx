import Link from "next/link";
import { requireModuleAccess } from "@/platform/auth/session";
import { listAttendings, CAPABILITY_KEYS } from "@/modules/schedule/services/attendings";
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
        <div className="rounded-lg border border-slate-200 bg-white px-6 py-10 text-center text-sm text-slate-500">
          No attendings yet.
        </div>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              {CAPABILITY_KEYS.map((k) => (
                <TH key={k}>{k}</TH>
              ))}
              <TH>Active</TH>
              <TH></TH>
            </TR>
          </THead>
          <tbody>
            {attendings.map((a) => (
              <TR key={a.id}>
                <TD>
                  <span className="font-medium text-slate-800">{a.scheduleName}</span>
                  <span className="block text-xs text-slate-400">{a.fullName}</span>
                </TD>
                {CAPABILITY_KEYS.map((k) => (
                  <TD key={k} className="text-slate-500 text-xs">{a[k] as string}</TD>
                ))}
                <TD>{a.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="default">Inactive</Badge>}</TD>
                <TD>
                  <Link href={`/schedule/attendings/${a.id}`} className="text-brand hover:underline text-sm">Edit</Link>
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
