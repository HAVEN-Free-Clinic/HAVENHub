import { requireModuleAccess } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { listAllConnections, listMyConnections, type ConnectionRow } from "@/platform/oauth/connections";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { Card } from "@/platform/ui/card";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Button } from "@/platform/ui/button";
import { EmptyState } from "@/platform/ui/empty-state";
import { DateTime } from "@/platform/dates/display";
import { revokeConnectionAction } from "./actions";

/**
 * Connected apps: the MCP clients (Claude, Cursor, a local agent) a person has allowed to read Hub
 * data as them, and the one place to cut one off.
 *
 * Under My Info because a connection is the person's own consent, like their
 * profile. An admin.access holder additionally sees every live connection in
 * the Hub and can revoke any of them, which is the switch for a lost laptop or
 * someone leaving.
 */
export default async function ConnectionsPage() {
  const person = await requireModuleAccess("my-info");
  const isAdmin = await can(person.personId, "admin.access");
  const [mine, all] = await Promise.all([
    listMyConnections(person.personId),
    isAdmin ? listAllConnections() : Promise.resolve(null),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Connected apps"
        description="Apps you have allowed to read Hub data as you. They see only what you can see, and cannot change anything."
      />
      <Card>
        {mine.length === 0 ? (
          <EmptyState inline>You have not connected any apps.</EmptyState>
        ) : (
          <ConnectionTable rows={mine} showPerson={false} />
        )}
      </Card>

      {all && (
        <section className="space-y-3">
          <SectionHeader>Every connected app</SectionHeader>
          <p className="text-sm text-foreground-soft">All live connections in the Hub. Revoking one takes effect on its next request.</p>
          <Card>
            {all.length === 0 ? (
              <EmptyState inline>No one has connected an app.</EmptyState>
            ) : (
              <ConnectionTable rows={all} showPerson />
            )}
          </Card>
        </section>
      )}
    </div>
  );
}

function ConnectionTable({ rows, showPerson }: { rows: ConnectionRow[]; showPerson: boolean }) {
  return (
    <Table>
      <THead>
        <TR>
          {showPerson && <TH>Person</TH>}
          <TH>App</TH>
          <TH>Access</TH>
          <TH>Connected</TH>
          <TH>Last used</TH>
          <TH><span className="sr-only">Actions</span></TH>
        </TR>
      </THead>
      <tbody>
        {rows.map((c) => (
          <TR key={c.id}>
            {showPerson && <TD>{c.personName}</TD>}
            <TD>{c.appLabel}</TD>
            <TD>{c.scope}</TD>
            <TD><DateTime value={c.createdAt} /></TD>
            <TD><DateTime value={c.lastUsedAt} fallback="Never" /></TD>
            <TD className="text-right">
              <form action={revokeConnectionAction}>
                <input type="hidden" name="connectionId" value={c.id} />
                <Button type="submit" variant="outline" size="sm">Disconnect</Button>
              </form>
            </TD>
          </TR>
        ))}
      </tbody>
    </Table>
  );
}
