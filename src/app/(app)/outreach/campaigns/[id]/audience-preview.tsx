"use client";

import type { AudiencePreview } from "@/platform/email/campaigns/service";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { UnresolvedPastedAddresses } from "./recipient-preview";

/**
 * The resolved recipient roll for a draft campaign.
 *
 * A count alone tells an admin how big the blast is but not whether it is the
 * RIGHT blast -- and the audience builder can now express negation and past-term
 * scopes, where an off-by-one-condition mistake looks identical at the count
 * level. Showing the names is the cheap check that catches it before the
 * type-the-exact-count confirmation ever comes up.
 */
export function AudiencePreviewPanel({ preview }: { preview: AudiencePreview }) {
  if (preview.count === 0) {
    return (
      <div className="space-y-3">
        <Alert tone="warning">
          This audience matches nobody. An empty or incomplete condition deliberately
          matches no one rather than everyone, so check that every condition has a value.
        </Alert>
        {/* Still shown on an empty roll: a campaign whose ONLY intended
            recipients were pasted, all of them mistyped, is exactly the case
            where this list is the whole explanation. */}
        <UnresolvedPastedAddresses addresses={preview.unresolved} />
      </div>
    );
  }

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-foreground">
          {preview.count} recipient{preview.count === 1 ? "" : "s"}
        </p>
        {preview.excludedNoEmail > 0 && (
          <p className="text-xs text-muted-foreground">
            {preview.excludedNoEmail} matched but {preview.excludedNoEmail === 1 ? "was" : "were"}{" "}
            excluded (no email address on file)
          </p>
        )}
      </div>

      <div className="max-h-96 overflow-y-auto">
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Email</TH>
            </TR>
          </THead>
          <tbody>
            {preview.sample.map((r) => (
              <TR key={r.email}>
                <TD className="text-foreground-soft">{r.name}</TD>
                <TD className="text-foreground-soft">{r.email}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </div>

      {preview.truncated && (
        <p className="text-xs text-muted-foreground">
          Showing the first {preview.sample.length} of {preview.count}. The count above is exact.
        </p>
      )}

      {/* The same component the Audience tab renders, so the one wording that
          keeps an out-of-scope address indistinguishable from a nonexistent one
          cannot drift between the two surfaces. */}
      <UnresolvedPastedAddresses addresses={preview.unresolved} />
    </Card>
  );
}
