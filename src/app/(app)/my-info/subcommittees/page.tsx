import { requireModuleAccess } from "@/platform/auth/session";
import { canSelfSignup, signupOptions } from "@/modules/admin/services/subcommittee-members";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Badge } from "@/platform/ui/badge";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { EmptyState } from "@/platform/ui/empty-state";
import { SetBreadcrumbLeaf } from "@/platform/ui/breadcrumb-context";
import { CopyButton } from "@/platform/ui/copy-button";
import { joinAction, leaveAction } from "./actions";

/**
 * Subcommittee sign-up. Lists the subcommittees open for sign-up plus any the
 * person is already on, with who leads each and how full it is. Joining
 * several is allowed. Under My Info because it is the person's own choice
 * about themselves, reachable by every signed-in member.
 */
export default async function SubcommitteeSignupPage() {
  const person = await requireModuleAccess("my-info");
  const [options, eligible] = await Promise.all([
    signupOptions(person.personId),
    canSelfSignup(person.personId),
  ]);
  const mine = options.filter((o) => o.myRole !== null);

  return (
    <div className="space-y-8">
      <SetBreadcrumbLeaf label="Subcommittees" />
      <PageHeader
        title="Subcommittees"
        description="Join a subcommittee to help run HAVEN beyond clinic shifts. You can join more than one."
      />

      {!eligible && (
        <Alert tone="info">
          Subcommittee sign-up is for current volunteers and directors. Once you are on this
          term&apos;s roster you can join here.
        </Alert>
      )}

      {mine.length > 0 && (
        <p className="text-sm text-foreground-soft">
          You are on {mine.map((m) => m.name).join(", ")}.
        </p>
      )}

      {options.length === 0 ? (
        <Card>
          <EmptyState inline>No subcommittees are open for sign-up right now. Check back later.</EmptyState>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {options.map((o) => {
            const full = o.capacity !== null && o.memberCount >= o.capacity;
            const spotsLeft = o.capacity !== null ? Math.max(o.capacity - o.memberCount, 0) : null;
            return (
              <section key={o.id} aria-labelledby={`sc-${o.id}`}>
                <Card className="flex h-full flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 id={`sc-${o.id}`} className="text-lg font-semibold text-foreground">{o.name}</h2>
                    {o.myRole === "LEAD" && <Badge tone="brand">You lead this</Badge>}
                    {o.myRole === "MEMBER" && <Badge tone="success">Joined</Badge>}
                    {!o.signupOpen && <Badge tone="default">Sign-up closed</Badge>}
                  </div>
                  {o.description && (
                    <p className="whitespace-pre-line text-sm text-foreground-soft">{o.description}</p>
                  )}
                  <dl className="space-y-1 text-sm">
                    <div className="flex gap-2">
                      <dt className="text-muted-foreground">Led by</dt>
                      <dd className="text-foreground-soft">{o.leads.length > 0 ? o.leads.join(", ") : "To be announced"}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-muted-foreground">Spots</dt>
                      <dd className="text-foreground-soft">
                        {spotsLeft === null
                          ? `${o.memberCount} ${o.memberCount === 1 ? "member" : "members"}, no limit`
                          : full
                            ? "Full"
                            : `${spotsLeft} of ${o.capacity} left`}
                      </dd>
                    </div>
                  </dl>
                  {o.roster && (
                    <details className="text-sm">
                      <summary className="cursor-pointer font-medium text-foreground">
                        Your roster ({o.roster.length})
                      </summary>
                      <ul className="mt-2 space-y-1">
                        {o.roster.map((r) => (
                          <li key={`${r.name}-${r.email}`} className="text-foreground-soft">
                            {r.name}
                            {r.role === "LEAD" && <span className="text-muted-foreground"> (lead)</span>}
                            {r.email && <span className="text-muted-foreground"> · {r.email}</span>}
                          </li>
                        ))}
                      </ul>
                      <CopyButton
                        className="mt-2"
                        label="Copy all emails"
                        value={o.roster.flatMap((r) => (r.email ? [r.email] : [])).join("; ")}
                      />
                    </details>
                  )}
                  <div className="mt-auto pt-1">
                    {o.myRole === "MEMBER" ? (
                      <form action={leaveAction}>
                        <input type="hidden" name="subcommitteeId" value={o.id} />
                        <ConfirmButton size="sm" label="Leave" confirmLabel={`Leave ${o.name}?`} />
                      </form>
                    ) : o.myRole === null && o.signupOpen ? (
                      <form action={joinAction}>
                        <input type="hidden" name="subcommitteeId" value={o.id} />
                        <Button type="submit" size="sm" disabled={!eligible || full}>
                          {full ? "Full" : "Join"}
                        </Button>
                      </form>
                    ) : null}
                  </div>
                </Card>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
