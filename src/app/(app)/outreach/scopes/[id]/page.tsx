import { notFound, redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import {
  getScope,
  updateScope,
  deleteScope,
  grantScope,
  revokeScope,
  ScopeValidationError,
} from "@/platform/email/audience/scopes";
import { prisma } from "@/platform/db";
import { isAudience } from "@/platform/email/audience/types";
import type { Audience } from "@/platform/email/audience/types";
import { PERSON_FIELD_VIEWS } from "@/platform/email/audience/person-fields";
import { loadAudienceBuilderOptions } from "@/platform/email/audience/builder-options";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { Input, Field } from "@/platform/ui/input";
import { Alert } from "@/platform/ui/alert";
import { GRAPH_SENDER_ADDRESSES, SENDING_DOMAINS } from "@/platform/email/sending-domains";
import { mailConnectionStatus } from "@/platform/email/oauth";
import { describeAutoIssue } from "@/platform/email/sender-identity";
import { AudienceBuilder } from "../../campaigns/[id]/audience-builder";
import { GrantForm, type GrantPersonOption } from "./grant-form";
import { ScopeIdentityFields } from "./identity-fields";
import type { SendingDomainMap } from "../../sender-identity-notes";

export default async function ScopeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  await requirePermission("outreach.manage_scopes");
  const { id } = await params;
  const { error } = await searchParams;
  const scope = await getScope(id);
  if (!scope) notFound();

  const grants = await prisma.audienceScopeGrant.findMany({
    where: { scopeId: id },
    include: { person: { select: { name: true } }, role: { select: { name: true } } },
  });
  const roster = await prisma.person.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true, contactEmail: true },
    orderBy: { name: "asc" },
  });
  const roles = await prisma.role.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });

  // What granting to each person would ALSO do: issue their own current address
  // as a sending identity. Resolved on the server (sendingAddressProblem reaches
  // @/platform/config, and "already issued / already revoked" is a DB fact) and
  // shipped to the form as a plain sentence per person. Printing it is what makes
  // the auto-issue an approval the admin gave rather than a side effect they
  // never saw: see the note in sender-identity.ts.
  const notes = await describeAutoIssue(roster);
  const people: GrantPersonOption[] = roster.map((p) => ({
    id: p.id,
    name: p.name,
    identityNote: notes.get(p.id)?.note ?? "",
    identitySeverity: notes.get(p.id)?.severity ?? "info",
    issuableAddress: notes.get(p.id)?.issuableAddress ?? null,
  }));

  const {
    departments: audienceDepartments,
    terms: audienceTerms,
    cycles: audienceCycles,
    subcommittees: audienceSubcommittees,
    zoneLabel: audienceZoneLabel,
  } = await loadAudienceBuilderOptions(scope.audience);

  // The allowlist as plain data plus the mailbox Graph is connected as, both for
  // the client-side identity notes. Resolved here because sending-domains.ts
  // reads `@/platform/config` at import and must not reach the browser.
  const domains: SendingDomainMap = Object.fromEntries(SENDING_DOMAINS);
  // See identities/page.tsx: the address rule out-ranks the domain table, so the
  // notes need both lists or they report the domain's verdict for an address
  // that does not follow it.
  const graphAddresses = [...GRAPH_SENDER_ADDRESSES];
  const mail = await mailConnectionStatus();

  async function saveAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("outreach.manage_scopes");
    const raw = (formData.get("audience") as string | null) ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      redirect(`/outreach/scopes/${id}?error=Invalid+audience`);
    }
    if (!isAudience(parsed)) redirect(`/outreach/scopes/${id}?error=Invalid+audience`);
    try {
      await updateScope(actor.personId, id, {
        name: ((formData.get("name") as string | null) ?? "").trim(),
        audience: parsed as Audience,
        // Always submitted by the form, so an empty field genuinely means
        // "clear it" rather than "leave it alone".
        fromEmail: (formData.get("fromEmail") as string | null) ?? "",
        fromName: (formData.get("fromName") as string | null) ?? "",
      });
    } catch (e) {
      // Chiefly the write-time allowlist refusal: an identity no transport can
      // sign for is a campaign that fails after the sender has hit Send, so the
      // save is refused here with the reason rather than stored to fail later.
      if (e instanceof ScopeValidationError) {
        redirect(`/outreach/scopes/${id}?error=${encodeURIComponent(e.message)}`);
      }
      throw e;
    }
    redirect(`/outreach/scopes/${id}`);
  }

  async function deleteAction() {
    "use server";
    const actor = await requirePermission("outreach.manage_scopes");
    try {
      await deleteScope(actor.personId, id);
    } catch (e) {
      if (e instanceof ScopeValidationError) {
        redirect(`/outreach/scopes/${id}?error=${encodeURIComponent(e.message)}`);
      }
      throw e;
    }
    redirect("/outreach/scopes");
  }

  async function grantAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("outreach.manage_scopes");
    const personId = ((formData.get("personId") as string | null) ?? "").trim();
    const roleId = ((formData.get("roleId") as string | null) ?? "").trim();
    // The address the form PRINTED beside the button, when there was one to
    // print. Passed through so the grant also approves it as a sending identity;
    // its absence means "grant the scope only". grantScope never writes this
    // value -- it matches it against the person's current contactEmail and
    // refuses on a mismatch, so a profile edited since this page rendered issues
    // nothing rather than issuing something the admin never read.
    const approved = ((formData.get("approvedAddress") as string | null) ?? "").trim();
    try {
      if (personId) {
        await grantScope(actor.personId, id, { personId }, approved || undefined);
      } else if (roleId) {
        // No address: a role has none. See grantScope.
        await grantScope(actor.personId, id, { roleId });
      }
    } catch (e) {
      if (e instanceof ScopeValidationError) {
        redirect(`/outreach/scopes/${id}?error=${encodeURIComponent(e.message)}`);
      }
      throw e;
    }
    redirect(`/outreach/scopes/${id}`);
  }

  async function revokeAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("outreach.manage_scopes");
    try {
      await revokeScope(actor.personId, (formData.get("grantId") as string) ?? "");
    } catch (e) {
      if (e instanceof ScopeValidationError) {
        redirect(`/outreach/scopes/${id}?error=${encodeURIComponent(e.message)}`);
      }
      throw e;
    }
    redirect(`/outreach/scopes/${id}`);
  }

  return (
    <div className="space-y-8">
      <PageHeader title={scope.name} description="Who campaigns sent under this scope may reach." />
      {error && <Alert tone="warning">{error}</Alert>}

      <form action={saveAction} className="space-y-6">
        <div className="max-w-sm">
          <Field label="Scope name">
            <Input name="name" type="text" defaultValue={scope.name} required />
          </Field>
        </div>
        <ScopeIdentityFields
          initialFromEmail={scope.fromEmail}
          initialFromName={scope.fromName}
          domains={domains}
          graphAddresses={graphAddresses}
          connectedMailbox={mail.account}
        />
        <AudienceBuilder
          fields={PERSON_FIELD_VIEWS}
          departments={audienceDepartments}
          terms={audienceTerms}
          cycles={audienceCycles}
          subcommittees={audienceSubcommittees}
          initial={scope.audience}
          zoneLabel={audienceZoneLabel}
        />
        <Button type="submit">Save scope</Button>
      </form>

      <div className="space-y-4 border-t border-border pt-6">
        <h2 className="text-base font-semibold text-foreground">Granted to</h2>
        {grants.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Not granted to anyone yet, so nobody can send under it.
          </p>
        ) : (
          <ul className="divide-y">
            {grants.map((g) => (
              <li key={g.id} className="flex items-center justify-between py-2">
                <span className="text-sm text-foreground-soft">
                  {g.person ? g.person.name : `Role: ${g.role?.name}`}
                </span>
                <form action={revokeAction}>
                  <input type="hidden" name="grantId" value={g.id} />
                  <Button type="submit" variant="outline">Revoke</Button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <GrantForm action={grantAction} people={people} roles={roles} />
      </div>

      <div className="border-t border-border pt-6">
        <form action={deleteAction}>
          <Button type="submit" variant="outline">Delete scope</Button>
        </form>
      </div>
    </div>
  );
}
