"use client";

import { useState } from "react";
import { Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Alert } from "@/platform/ui/alert";

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
 * The list is EMPTY for every delegated sender with nothing issued to them whose
 * campaign's scope carries no identity, and that is the ordinary case rather
 * than an edge one: their own profile address is deliberately not a claim (see
 * sender-identity.ts). They get the default row only, so this is the single
 * surface on which a sender meets that state, and it has to say what to do about
 * it rather than showing one inert entry with no explanation.
 *
 * What the default row must NOT claim is that the global email.sender setting is
 * what goes out. With no identity the enqueue falls to
 * resolveSenderForTemplate("campaign"), where a TEMPLATE or CATEGORY rule for the
 * campaign group wins BEFORE that setting (see sender-rules.ts), and such a rule
 * is exactly what the admin email screen exists to create. So the row names the
 * behaviour, not a specific address it cannot know.
 *
 * A stored choice that is no longer in the list is still shown, with the reason:
 * an issued address revoked after the campaign was composed -- or one reached
 * through a role the sender has since lost -- would otherwise vanish from the
 * form and silently re-save as the default.
 *
 * NO SenderIdentityNotes HERE, and deliberately not by oversight: it renders on
 * the three ADMIN surfaces (issue-form, identities/page, scopes identity-fields)
 * and was removed from this one. Those notes carry the Graph throughput ceiling
 * and the Send-As requirement, and both are facts that change an ADMIN's
 * decision when issuing an address or setting one on a scope. Neither changes a
 * SENDER's decision, because a sender can only pick from what an admin already
 * approved, so on this screen they are two warning panels about a choice that
 * has already been made for them. Do not add them back.
 *
 * The empty-state sentence below is NOT one of those notes and stays: it is one
 * line of plain text telling a sender what to do when they have no options at
 * all, and this is the only surface on which a sender meets that state.
 */
export function SenderPicker({
  options,
  initial,
}: {
  options: SenderOption[];
  initial: string | null;
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
                : "Default (the clinic's configured campaign sender)"}
            </option>
            {options.map((o) => (
              <option key={o.address} value={o.address}>
                {o.address} ({SOURCE_LABEL[o.source]})
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {options.length === 0 && (
        <p className="text-sm text-muted-foreground">
          You have no sending identities, so this campaign goes out from whichever address the
          clinic has configured for campaigns. To send as a specific address, ask an admin to set
          one on this campaign&apos;s audience scope, or to issue one to you.
        </p>
      )}

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
    </div>
  );
}
