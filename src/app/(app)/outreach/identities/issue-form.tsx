"use client";

import { useState } from "react";
import { Button } from "@/platform/ui/button";
import { Input, Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { SenderIdentityNotes, type SendingDomainMap } from "../sender-identity-notes";

type Option = { id: string; name: string };

/**
 * Issue an address to a person or to a role.
 *
 * The two target selects clear each other, exactly the way the scope GrantForm's
 * do, because the grant carries EXACTLY ONE target (a db-level CHECK, see
 * migration 20260902160000). Submit stays disabled until one is chosen, so the
 * XOR is something the form cannot violate rather than something the server has
 * to explain afterwards.
 *
 * Issuing an address that already exists adds a holder rather than failing: one
 * address is one row now, so that is how a shared mailbox reaches several
 * people. The form does not need to know which case it is in.
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
  roles,
  domains,
  connectedMailbox,
}: {
  action: (formData: FormData) => Promise<void>;
  people: Option[];
  roles: Option[];
  domains: SendingDomainMap;
  connectedMailbox: string | null;
}) {
  const [address, setAddress] = useState("");
  const [personId, setPersonId] = useState("");
  const [roleId, setRoleId] = useState("");

  return (
    <form action={action} className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Issue to a person">
          <Select
            name="personId"
            value={personId}
            onChange={(e) => {
              setPersonId(e.target.value);
              if (e.target.value) setRoleId("");
            }}
          >
            <option value="">None</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="or a role">
          <Select
            name="roleId"
            value={roleId}
            onChange={(e) => {
              setRoleId(e.target.value);
              if (e.target.value) setPersonId("");
            }}
          >
            <option value="">None</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
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
        <Button type="submit" disabled={!personId && !roleId}>
          Issue
        </Button>
      </div>
      {roleId && (
        <p className="text-sm text-muted-foreground">
          Everyone holding this role gains the address, and loses it the moment they lose the
          role. Nothing is stored per person, so there is no per-person grant to clean up.
        </p>
      )}
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
