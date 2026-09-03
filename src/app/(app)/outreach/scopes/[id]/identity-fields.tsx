"use client";

import { useState } from "react";
import { Input, Field } from "@/platform/ui/input";
import { SenderIdentityNotes, type SendingDomainMap } from "../../sender-identity-notes";

/**
 * The scope's sending identity, with the domain notes live under the field.
 *
 * Client-side for the same reason the issue form is: the two consequences that
 * matter (the Graph throughput ceiling and the Send-As requirement) depend on
 * the DOMAIN of whatever is currently typed, and an admin who only finds out
 * after saving has already committed every campaign under this scope to it.
 */
export function ScopeIdentityFields({
  initialFromEmail,
  initialFromName,
  domains,
  graphAddresses,
  connectedMailbox,
}: {
  initialFromEmail: string | null;
  initialFromName: string | null;
  domains: SendingDomainMap;
  graphAddresses: string[];
  connectedMailbox: string | null;
}) {
  const [fromEmail, setFromEmail] = useState(initialFromEmail ?? "");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Send campaigns as">
          <Input
            name="fromEmail"
            type="email"
            placeholder="Leave blank to use each sender's issued address"
            value={fromEmail}
            onChange={(e) => setFromEmail(e.target.value)}
          />
        </Field>
        <Field label="Display name (optional)">
          <Input
            name="fromName"
            type="text"
            defaultValue={initialFromName ?? ""}
            placeholder="HAVEN Pediatrics"
          />
        </Field>
      </div>
      <p className="text-sm text-muted-foreground">
        This outranks anything issued to the sender. Leave it blank and each sender falls back to an
        address issued to them on the Sending identities page, and then to the clinic&apos;s
        configured sender. A sender&apos;s own profile address is never used: it is unverified free
        text, so it has to be issued to them first.
      </p>
      <SenderIdentityNotes
        address={fromEmail}
        domains={domains}
        graphAddresses={graphAddresses}
        connectedMailbox={connectedMailbox}
        warnUnsignable={fromEmail.includes("@")}
      />
    </div>
  );
}
