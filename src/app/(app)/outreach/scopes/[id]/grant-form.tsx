"use client";

import { useState } from "react";
import { Button } from "@/platform/ui/button";
import { Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";

type Option = { id: string; name: string };

/**
 * A person option, plus what granting to them does to their sending identity.
 *
 * The sentence is PRECOMPUTED ON THE SERVER, for two reasons. sendingAddressProblem
 * reaches `@/platform/config` through sending-domains.ts and must not be bundled
 * into the browser; and whether the address is already issued (or was revoked)
 * is a database fact this component has no way to know.
 */
export type GrantPersonOption = Option & {
  identityNote: string;
  /** How loudly to print the note. Computed server-side; see AutoIssuePreview. */
  identitySeverity: "info" | "warning";
  /**
   * The address this grant would also issue, or null when it would issue
   * nothing (none on file, unsignable, already revoked, already issued).
   *
   * Submitted back with the form, and matched server-side against the person's
   * CURRENT contactEmail before anything is written. That is what turns the
   * printed sentence into the approval itself rather than a label beside it: a
   * profile edited between this render and the click refuses instead of issuing
   * an address nobody read. See grantScope's `approvedAddress`.
   */
  issuableAddress: string | null;
};

export function GrantForm({
  action,
  people,
  roles,
}: {
  action: (formData: FormData) => Promise<void>;
  people: GrantPersonOption[];
  roles: Option[];
}) {
  const [personId, setPersonId] = useState("");
  const [roleId, setRoleId] = useState("");

  const selectedPerson = people.find((p) => p.id === personId);

  return (
    <form action={action} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Grant to a person">
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
              <option key={p.id} value={p.id}>{p.name}</option>
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
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </Select>
        </Field>
        {/* THE APPROVAL IS IN THE LABEL, not only in the prose below it.
            The sentence explaining what will be issued sits downstream of the
            control, in the page's lowest-emphasis style, and an admin who
            reads only the button they are about to press should still be
            told they are approving an address. Naming it here makes "Grant"
            and "Grant and issue X" two visibly different acts. */}
        <Button type="submit" disabled={!personId && !roleId}>
          {selectedPerson?.issuableAddress
            ? `Grant and issue ${selectedPerson.issuableAddress}`
            : "Grant"}
        </Button>
      </div>

      {/* A person grant does a SECOND thing, and the admin has to be looking at
          the address they are approving before they click. That is what makes
          this an approval rather than an invisible side effect: the address
          comes from a self-service profile field, so the whole safety of the
          mechanism rests on a human having seen this exact string once.
          Emphasised when it is a WARNING (the address is already somebody
          else's live identity), which is the case that most needs reading. */}
      {selectedPerson && (
        <p
          className={
            // Branches on the SEVERITY the server computed, never on the text.
            // This used to test note.startsWith("WARNING:"), which tied the
            // styling to a prose string nothing pinned: a copy edit would have
            // downgraded the impostor note to muted with every test still green.
            selectedPerson.identitySeverity === "warning"
              ? "text-sm font-medium text-critical-foreground"
              : "text-sm text-muted-foreground"
          }
        >
          {selectedPerson.identityNote}
        </p>
      )}
      {/* The approval itself. Present only when there is genuinely something to
          approve, so a grant that issues nothing sends nothing to match. */}
      {selectedPerson?.issuableAddress && (
        <input type="hidden" name="approvedAddress" value={selectedPerson.issuableAddress} />
      )}

      {/* The asymmetry, said out loud rather than left to be discovered. */}
      {roleId && (
        <p className="text-sm text-muted-foreground">
          Everyone holding this role gains the scope, and loses it with the role. A role has no
          address of its own, so no sending identity is issued here. To give this role an address,
          issue one to it on the sending identities page.
        </p>
      )}
    </form>
  );
}
