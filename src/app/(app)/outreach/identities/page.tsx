/**
 * /outreach/identities -- issue and revoke the addresses a person may send
 * campaigns as.
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

  const [identities, people, mail, me] = await Promise.all([
    listIssuedIdentities(),
    prisma.person.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
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
    try {
      await issueSendingIdentity(admin.personId, {
        personId: ((formData.get("personId") as string | null) ?? "").trim(),
        address: ((formData.get("address") as string | null) ?? "").trim(),
        displayName: (formData.get("displayName") as string | null) ?? null,
      });
    } catch (e) {
      if (e instanceof SenderIdentityError) back(e.message);
      throw e;
    }
    back();
  }

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
   */
  async function testAction(formData: FormData) {
    "use server";
    const admin = await requirePermission("outreach.manage_scopes");
    const address = ((formData.get("address") as string | null) ?? "").trim();
    const row = await prisma.person.findUnique({
      where: { id: admin.personId },
      select: { contactEmail: true },
    });
    if (!row?.contactEmail) {
      back("You have no contact email on file, so there is nowhere to send the test.");
    }
    try {
      await sendSenderTest(admin.personId, { toEmail: row.contactEmail, fromEmail: address });
    } catch (e) {
      back(e instanceof Error ? e.message : "The test send failed.");
    }
    redirect(`${PATH}?sent=${encodeURIComponent(address)}`);
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Sending identities"
        description="Addresses a person may send a campaign as. Without one, a delegated sender can only use their campaign's scope identity or their own address."
      />
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
          domains={domains}
          connectedMailbox={mail.account}
        />
      </Card>

      <div className="space-y-4">
        <h2 className="text-base font-semibold text-foreground">Issued</h2>
        {identities.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing issued yet. Every sender can still use their campaign&apos;s scope identity and
            their own address.
          </p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Person</TH>
                <TH>Address</TH>
                <TH>Sends via</TH>
                <TH>Issued</TH>
                <TH>Status</TH>
                <TH>{""}</TH>
              </TR>
            </THead>
            <tbody>
              {identities.map((identity) => (
                <TR key={identity.id}>
                  <TD className="text-foreground-soft">{identity.personName}</TD>
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
                    <DateOnly value={identity.issuedAt} />
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
                            <input type="hidden" name="address" value={identity.address} />
                            <Button type="submit" variant="outline">
                              Test to me
                            </Button>
                          </form>
                        )}
                        <form action={revokeAction}>
                          <input type="hidden" name="id" value={identity.id} />
                          <ConfirmButton label="Revoke" />
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
