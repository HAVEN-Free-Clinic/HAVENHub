"use client";

import { useState } from "react";
import { Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Alert } from "@/platform/ui/alert";
import { SenderIdentityNotes, type SendingDomainMap } from "../../sender-identity-notes";

export type SenderOption = {
  address: string;
  displayName: string | null;
  /** Both values name something an admin did; there is no third. */
  source: "scope" | "issued";
};

const SOURCE_LABEL: Record<SenderOption["source"], string> = {
  scope: "this campaign's scope",
  issued: "issued to you",
};

/**
 * Choose which identity this campaign sends as.
 *
 * A CLOSED LIST, not a text field, and that is the security property rather than
 * a convenience: the server accepts only this campaign's scope identity or an
 * address issued to this person, so a free-text box could only ever offer ways
 * to be refused. The options here are the exact list the server authorizes
 * against (see senderIdentitiesForCampaign), so the menu and the check cannot
 * drift apart.
 *
 * The list can legitimately be EMPTY, and that is not a bug to design around: a
 * sender with nothing issued to them, whose campaign's scope carries no
 * identity, has no claim of their own to fall back on. Their own profile address
 * is deliberately not one (see sender-identity.ts). They get the default option
 * only, which is the clinic's configured sender.
 *
 * A stored choice that is no longer in the list is still shown, with the reason:
 * an issued address revoked after the campaign was composed would otherwise
 * vanish from the form and silently re-save as the default.
 */
export function SenderPicker({
  options,
  initial,
  domains,
  connectedMailbox,
}: {
  options: SenderOption[];
  initial: string | null;
  domains: SendingDomainMap;
  connectedMailbox: string | null;
}) {
  const stale = initial !== null && !options.some((o) => o.address === initial);
  const [value, setValue] = useState(stale ? "" : (initial ?? ""));
  const selected = options.find((o) => o.address === value) ?? null;
  const fallback = options[0] ?? null;

  return (
    <div className="space-y-3">
      <div className="max-w-md">
        <Field label="Send from">
          <Select name="fromEmail" value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">
              {fallback
                ? `Default (${fallback.address}, ${SOURCE_LABEL[fallback.source]})`
                : "Default (the clinic's configured sender)"}
            </option>
            {options.map((o) => (
              <option key={o.address} value={o.address}>
                {o.address} ({SOURCE_LABEL[o.source]})
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {stale && (
        <Alert tone="warning">
          This campaign was set to send from <strong>{initial}</strong>, which is no longer
          available to you. Saving now will send from the default instead.
        </Alert>
      )}

      {selected?.displayName && (
        <p className="text-sm text-muted-foreground">
          Recipients see it as {selected.displayName} &lt;{selected.address}&gt;.
        </p>
      )}

      <SenderIdentityNotes
        address={selected?.address ?? fallback?.address ?? null}
        domains={domains}
        connectedMailbox={connectedMailbox}
      />
    </div>
  );
}
