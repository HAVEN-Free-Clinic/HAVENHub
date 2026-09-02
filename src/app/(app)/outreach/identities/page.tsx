/**
 * /outreach/identities -- issue and revoke the addresses a person may send
 * campaigns as.
 *
 * ONE ROW PER ADDRESS since Task 3, with its holders listed underneath. An
 * address can be handed to a PERSON or to a ROLE, and a role grant is expanded
 * live on every resolve (see sender-identity.ts), so this screen is where a
 * role's membership silently becomes a sending permission. That is why the
 * holder list names the role explicitly rather than flattening it into the
 * people it currently reaches: the grant is the durable fact, the people are not.
 *
 * TWO REVOCATIONS, and the screen has to keep them visibly different. Removing
 * one holder is a delete of that grant and leaves the address live for everyone
 * else. Revoking the ADDRESS retires it for everybody at once, through every
 * route, and is the one that leaves a record: the row stays, marked.
 *
 * GATED ON outreach.manage_scopes, deliberately reusing the existing permission
 * rather than minting a fourth. Setting a scope's identity is unambiguously that
 * permission's job, and an admin who can do that can already decide what address
 * every campaign under a delegation boundary sends from. Issuing an address to
 * one person is the narrower half of the same decision, so splitting it out
 * would add a permission, a migration, and a backfill for a separation of duties
 * nobody asked for and nobody could staff.
 *
 * See sender-identity.ts for the resolution order this screen feeds.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { prisma } from "@/platform/db";
import {
  issueSendingIdentity,
  listIssuedIdentities,
  revokeSendingIdentity,
  revokeSendingIdentityGrant,
  SenderIdentityError,
} from "@/platform/email/sender-identity";
import { SENDING_DOMAINS } from "@/platform/email/sending-domains";
import { mailConnectionStatus } from "@/platform/email/oauth";
import { sendSenderTest } from "@/modules/admin/services/email";
import { PageHeader } from "@/platform/ui/page-header";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
import { Button } from "@/platform/ui/button";
import { Badge } from "@/platform/ui/badge";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { DateOnly } from "@/platform/dates/display";
import { SenderIdentityNotes, type SendingDomainMap } from "../sender-identity-notes";
import { IssueIdentityForm } from "./issue-form";

const PATH = "/outreach/identities";

function back(message?: string): never {
  redirect(message ? `${PATH}?error=${encodeURIComponent(message)}` : PATH);
}

export default async function SendingIdentitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const actor = await requirePermission("outreach.manage_scopes");
  const { error, sent } = await searchParams;

  const [identities, people, roles, mail, me] = await Promise.all([
    listIssuedIdentities(),
    prisma.person.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    // Every role, not only the ones already holding something: the same list the
    // scope grant form offers, for the same reason.
    prisma.role.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    mailConnectionStatus(),
    prisma.person.findUnique({
      where: { id: actor.personId },
      select: { contactEmail: true },
    }),
  ]);

  // The allowlist as plain data for the client notes component. It is resolved
  // here because sending-domains.ts reads `@/platform/config` at import and must
  // not be bundled into the browser.
  const domains: SendingDomainMap = Object.fromEntries(SENDING_DOMAINS);

  // Whoever can run the full sender test (any From, any recipient) already holds
  // the email-admin permission. This page offers only the narrower self-test.
  const canRunFullTest = await can(actor.personId, "admin.manage_sync");

  async function issueAction(formData: FormData) {
    "use server";
    const admin = await requirePermission("outreach.manage_scopes");
    const personId = ((formData.get("personId") as string | null) ?? "").trim();
    const roleId = ((formData.get("roleId") as string | null) ?? "").trim();
    // Exactly one target, decided here rather than by the CHECK constraint, so
    // the admin gets a sentence instead of a raw constraint violation. Person
    // wins a form that somehow submitted both; the form itself clears one when
    // the other is chosen, so that is a defence rather than a real branch.
    if (!personId && !roleId) back("Choose a person or a role to issue the address to.");
    const target = personId ? { personId } : { roleId };
    try {
      await issueSendingIdentity(admin.personId, {
        ...target,
        address: ((formData.get("address") as string | null) ?? "").trim(),
        displayName: (formData.get("displayName") as string | null) ?? null,
      });
    } catch (e) {
      if (e instanceof SenderIdentityError) back(e.message);
      throw e;
    }
    back();
  }

  /** Retire the ADDRESS: nobody may send as it any more, through any grant. */
  async function revokeAction(formData: FormData) {
    "use server";
    const admin = await requirePermission("outreach.manage_scopes");
    try {
      await revokeSendingIdentity(admin.personId, (formData.get("id") as string) ?? "");
    } catch (e) {
      if (e instanceof SenderIdentityError) back(e.message);
      throw e;
    }
    back();
  }

  /** Take the address away from ONE holder, leaving it live for the rest. */
  async function revokeGrantAction(formData: FormData) {
    "use server";
    const admin = await requirePermission("outreach.manage_scopes");
    try {
      await revokeSendingIdentityGrant(admin.personId, (formData.get("grantId") as string) ?? "");
    } catch (e) {
      if (e instanceof SenderIdentityError) back(e.message);
      throw e;
    }
    back();
  }

  /**
   * Send one test message FROM an issued address TO the admin's own contact
   * address, through sendSenderTest -- the same function the email admin screen
   * uses, which builds the transport the allowlist actually selects. That is
   * what makes it a genuine pre-flight check on a Send-As grant rather than a
   * second, weaker path that would confirm nothing.
   *
   * The recipient is FIXED to the admin's own contactEmail rather than taken
   * from the form. sendSenderTest's own screen is gated on admin.manage_sync;
   * this one is gated on outreach.manage_scopes, and letting that permission
   * send a live message to an arbitrary address would widen its reach beyond
   * anything outreach itself grants. Sending to yourself answers the only
   * question being asked ("will Graph accept this From") and reaches nobody new.
   *
   * The FROM is resolved from an id, and the row is re-read here with
   * `revokedAt: null` rather than trusted from the form. The button renders only
   * on an active row, so reading a raw address out of the FormData would leave
   * the server not enforcing what the UI implies -- and it would be the one read
   * of an identity on this page that skips the revocation filter, which is
   * exactly the shape the whole revocation risk is about.
   */
  async function testAction(formData: FormData) {
    "use server";
    const admin = await requirePermission("outreach.manage_scopes");
    const identity = await prisma.sendingIdentity.findFirst({
      where: { id: ((formData.get("id") as string | null) ?? "").trim(), revokedAt: null },
      select: { address: true },
    });
    if (!identity) back("That sending identity is no longer active.");
    const row = await prisma.person.findUnique({
      where: { id: admin.personId },
      select: { contactEmail: true },
    });
    if (!row?.contactEmail) {
      back("You have no contact email on file, so there is nowhere to send the test.");
    }
    try {
      await sendSenderTest(admin.personId, {
        toEmail: row.contactEmail,
        fromEmail: identity.address,
      });
    } catch (e) {
      back(e instanceof Error ? e.message : "The test send failed.");
    }
    redirect(`${PATH}?sent=${encodeURIComponent(identity.address)}`);
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Sending identities"
        description="Addresses a campaign may be sent as, and who may use them. An address can be issued to one person or to a role, in which case everyone holding that role gains it and loses it with the role. Without one, a delegated sender can only use their campaign's scope identity. A person's own profile address is not a sending identity: it is unverified free text, so it has to be issued here before they can send as it."
      />
      {/* Usually redundant, and kept as the fallback rather than the primary
          channel: FlashReader (root layout) CLAIMS an `error` param, toasts it,
          and strips it with router.replace, so in practice the refusal reaches
          the admin as a transient toast and this branch has already lost its
          value by the time the page re-renders. Verified in a browser. Left in
          place so a refusal is still visible if that param ever stops being
          claimed, which is the failure this page must not have. */}
      {error && <Alert tone="error">{error}</Alert>}
      {sent && (
        <Alert tone="success">
          {/* {" "} after the interpolation on purpose: JSX drops the leading
              space of a text child that wraps to the next line. */}
          Test message queued from <strong>{sent}</strong>{" "}
          to your contact address. If it does not arrive, that address is not usable and the
          campaign would have failed the same way.
        </Alert>
      )}

      <Card className="space-y-4">
        <h2 className="text-base font-semibold text-foreground">Issue an address</h2>
        <IssueIdentityForm
          action={issueAction}
          people={people}
          roles={roles}
          domains={domains}
          connectedMailbox={mail.account}
        />
      </Card>

      <div className="space-y-4">
        <h2 className="text-base font-semibold text-foreground">Issued</h2>
        {identities.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing issued yet. Senders can still use their campaign&apos;s scope identity, and
            anyone without one sends from the clinic&apos;s configured address.
          </p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Address</TH>
                <TH>Sends via</TH>
                <TH>Held by</TH>
                <TH>Created</TH>
                <TH>Status</TH>
                <TH>{""}</TH>
              </TR>
            </THead>
            <tbody>
              {identities.map((identity) => (
                <TR key={identity.id}>
                  <TD className="text-foreground-soft">
                    {identity.address}
                    {identity.displayName && (
                      <span className="block text-xs text-subtle-foreground">
                        {identity.displayName}
                      </span>
                    )}
                  </TD>
                  <TD className="text-foreground-soft">
                    {identity.transport ?? (
                      // Not a styling nicety: an identity whose domain has since
                      // left the allowlist would be skipped at send with nothing
                      // to explain it, so the row has to say so itself.
                      <Badge tone="critical">No signer</Badge>
                    )}
                  </TD>
                  <TD className="text-foreground-soft">
                    {identity.grants.length === 0 ? (
                      // Reachable and worth naming: revoking the last holder
                      // leaves the address itself live, so without this the row
                      // would look issued while nobody could actually use it.
                      <span className="text-xs text-subtle-foreground">Nobody</span>
                    ) : (
                      <ul className="space-y-1">
                        {identity.grants.map((grant) => (
                          <li key={grant.id} className="flex items-center gap-2">
                            <span className="text-sm">
                              {grant.kind === "role" ? `Role: ${grant.targetName}` : grant.targetName}
                            </span>
                            <span className="text-xs text-subtle-foreground">
                              <DateOnly value={grant.grantedAt} />
                            </span>
                            {identity.revokedAt === null && (
                              <form action={revokeGrantAction}>
                                <input type="hidden" name="grantId" value={grant.id} />
                                <Button type="submit" variant="outline">
                                  Remove
                                </Button>
                              </form>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </TD>
                  <TD className="text-foreground-soft">
                    <DateOnly value={identity.createdAt} />
                  </TD>
                  <TD className="text-foreground-soft">
                    {identity.revokedAt ? (
                      <Badge tone="critical">
                        Revoked <DateOnly value={identity.revokedAt} />
                      </Badge>
                    ) : (
                      <Badge tone="success">Active</Badge>
                    )}
                  </TD>
                  <TD>
                    {identity.revokedAt === null && (
                      <div className="flex items-center justify-end gap-2">
                        {me?.contactEmail && (
                          <form action={testAction}>
                            {/* The id, not the address: the server re-reads the
                                row with revokedAt: null rather than trusting a
                                From that came from the page. */}
                            <input type="hidden" name="id" value={identity.id} />
                            <Button type="submit" variant="outline">
                              Test to me
                            </Button>
                          </form>
                        )}
                        <form action={revokeAction}>
                          <input type="hidden" name="id" value={identity.id} />
                          {/* Retires the ADDRESS for every holder at once, which
                              is why it is the confirmed one and "Remove" beside
                              a single holder is not. */}
                          <ConfirmButton label="Revoke address" />
                        </form>
                      </div>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}

        {/* The notes for every distinct ACTIVE address, once each. Rendered here
            rather than inside the table so a two-paragraph warning does not
            wreck the row layout. */}
        {[...new Set(identities.filter((i) => !i.revokedAt).map((i) => i.address))].map(
          (address) => (
            <SenderIdentityNotes
              key={address}
              address={address}
              domains={domains}
              connectedMailbox={mail.account}
            />
          ),
        )}

        {canRunFullTest && (
          <p className="text-sm text-muted-foreground">
            To test an address against a recipient other than yourself, use the sender test on{" "}
            <Link className="underline underline-offset-2" href="/admin/email">
              the email admin screen
            </Link>
            .
          </p>
        )}
      </div>
    </div>
  );
}
