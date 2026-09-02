"use client";

import { useState } from "react";
import { Button } from "@/platform/ui/button";
import { Input, Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { SenderIdentityNotes, type SendingDomainMap } from "../sender-identity-notes";

type Option = { id: string; name: string };

/**
 * Issue an address to a person.
 *
 * Client-side so the sending-domain notes react to what is being typed. An
 * unsignable address is refused by the server either way (issueSendingIdentity
 * validates against the allowlist before it writes); showing the reason while
 * the field is still focused is what stops the admin from finding out through a
 * redirect.
 */
export function IssueIdentityForm({
  action,
  people,
  domains,
  connectedMailbox,
}: {
  action: (formData: FormData) => Promise<void>;
  people: Option[];
  domains: SendingDomainMap;
  connectedMailbox: string | null;
}) {
  const [address, setAddress] = useState("");

  return (
    <form action={action} className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Issue to">
          <Select name="personId" required defaultValue="">
            <option value="" disabled>
              Choose a person
            </option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Address">
          <Input
            name="address"
            type="email"
            required
            placeholder="recruitment@example.org"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </Field>
        <Field label="Display name (optional)">
          <Input name="displayName" type="text" placeholder="HAVEN Recruitment" />
        </Field>
        <Button type="submit">Issue</Button>
      </div>
      <SenderIdentityNotes
        address={address}
        domains={domains}
        connectedMailbox={connectedMailbox}
        // Quiet until the address at least looks like one, so the panel does not
        // shout at every keystroke of a half-typed local part.
        warnUnsignable={address.includes("@")}
      />
    </form>
  );
}
