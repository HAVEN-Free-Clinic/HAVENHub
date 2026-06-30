/**
 * EpicPanel: Epic account request panel for My Info.
 *
 * Displays the person's current Epic ID (read-only; IT-managed) and either:
 *   - A status line when an open (PENDING or SUBMITTED) request exists.
 *   - A request form otherwise.
 *
 * Visual conventions match hipaa-panel.tsx: a bordered section with a heading,
 * helper text, and inline error display.
 */

import type { EpicRequest } from "@prisma/client";
import { Card } from "@/platform/ui/card";
import { Input, Field, ReadonlyField } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { FormActions } from "@/platform/ui/form";

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

type EpicPanelProps = {
  epicId: string | null;
  openRequest: Pick<EpicRequest, "kind" | "status" | "createdAt"> | null;
  action: (formData: FormData) => Promise<void>;
  error?: string;
  saved?: boolean;
};

export function EpicPanel({ epicId, openRequest, action, error, saved }: EpicPanelProps) {
  // Determine available kinds based on whether epicId is on file
  const hasEpicId = !!epicId;

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Epic Access</h3>
        <p className="mt-0.5 text-xs text-subtle-foreground">Managed by the IT team.</p>
      </div>

      {saved && <Alert tone="success">Epic request submitted.</Alert>}

      {/* Current Epic ID row */}
      <ReadonlyField
        label="Epic ID"
        value={epicId || "None on file"}
      />

      {/* Open request status or request form */}
      {openRequest ? (
        <div className="rounded-xl border border-border bg-muted px-4 py-3">
          <div className="flex items-center gap-2">
            <Badge tone="warning">
              {openRequest.kind} {openRequest.status === "SUBMITTED" ? "submitted to YNHH" : "request pending"}
            </Badge>
            <span className="text-xs text-muted-foreground">since {formatDate(openRequest.createdAt)}</span>
          </div>
          <p className="mt-1.5 text-xs text-subtle-foreground">
            {openRequest.status === "SUBMITTED"
              ? "Your request has been submitted to YNHH IT. You will be contacted when it is processed."
              : "Your request is being reviewed by the IT team."}
          </p>
        </div>
      ) : (
        <div>
          <h4 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Request Epic Access</h4>

          {error && (
            <Alert tone="error" className="mb-3">
              {error}
            </Alert>
          )}

          <form action={action} className="space-y-3">
            {/* Kind selection */}
            {!hasEpicId ? (
              <>
                <input type="hidden" name="kind" value="NEW" />
                <p className="text-sm text-foreground-soft">Request a new Epic account.</p>
              </>
            ) : (
              <Field label="Request type">
                <Select name="kind" defaultValue="RENEW" className="max-w-[200px]">
                  <option value="MODIFY">Modify (update account)</option>
                  <option value="RENEW">Renew (extend access)</option>
                </Select>
              </Field>
            )}

            <Field label="Notes (optional)">
              <Input name="notes" placeholder="Any details for the IT team" />
            </Field>

            <FormActions>
              <SubmitButton variant="outline" size="sm" pendingLabel="Requesting…">
                Request
              </SubmitButton>
            </FormActions>
          </form>
        </div>
      )}
    </Card>
  );
}
