"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye } from "lucide-react";
import { Alert } from "@/platform/ui/alert";
import { Modal } from "@/platform/ui/modal";
import { Button, buttonClasses } from "@/platform/ui/button";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { REJECTION_REASONS, REJECTION_NOTE_MAX } from "@/platform/compliance/rejection";
import { runAction } from "@/platform/ui/run-action";
import { formatForDateInput } from "@/platform/dates";
import { useTimeZone } from "@/platform/dates/client";
import { FormRow, RowField } from "@/platform/ui/form";

type CertificateViewerProps = {
  certId: string;
  fileName: string;
  /** Shown in the header when a manager is viewing someone else's certificate. */
  ownerName?: string;
  /** The cert's current completion date, if any. Controls whether entry is offered. */
  completionDate?: Date | null;
  /** True only when the viewer holds volunteers.manage_compliance. Gates date entry. */
  canEditDate?: boolean;
  /** True only for superadmins. Allows overwriting a date that is already set. */
  canEditExistingDate?: boolean;
  /** Bound server action: (dateIso) => result. Required for entry to render. */
  onSetDate?: (dateIso: string) => Promise<{ error?: string }>;
  /** True when the viewer may verify (holds manage_compliance or admin). */
  canVerify?: boolean;
  /** Whether the cert already carries a verified stamp. */
  verified?: boolean;
  /** Bound server action: () => result. Required for the Verify button to render. */
  onVerify?: () => Promise<{ error?: string }>;
  /** True when the viewer may reject (same gate as verifying). */
  canReject?: boolean;
  /** Whether this certificate has already been refused. */
  rejected?: boolean;
  /** Bound server action: (reason, note) => result. Required for Reject to render. */
  onReject?: (reason: string, note: string) => Promise<{ error?: string }>;
  /** Bound server action: () => result. Required for "Undo rejection" to render. */
  onUndoReject?: () => Promise<{ error?: string }>;
};

/**
 * "View" button that opens a modal previewing the certificate PDF inline. The
 * preview is only mounted while the modal is open (so roster rows never each
 * load a PDF) and unmounts on close. Download / Open-in-new-tab are provided as
 * fallbacks for browsers that will not render PDFs in a frame.
 *
 * Those fallbacks are not hypothetical. Members reach this modal, find the
 * preview area completely blank, and go hunting for another way to read their
 * own certificate (PostHog inbox 01a02ff5).
 *
 * The cause is on the browser's side of the frame, not ours. Rebuilding this
 * modal around a PDF served with the route's exact response headers cleared
 * both structural suspects: the `default-src 'none'` CSP the route sends, and
 * the `backdrop-filter` on the modal's glass panel. Each renders the PDF fine,
 * and a frame inside the glass panel renders identically to one outside it.
 * What remains is the viewer plugin -- a PDF handler other than the browser's
 * built-in one, or a mobile browser that will not frame PDFs at all -- painting
 * nothing while the load still reports success. No event fires, so the app
 * cannot detect it.
 *
 * The frame stays an <iframe>. Swapping in an <object>, whose fallback children
 * would at least cover an outright load failure, renders identically in Chrome
 * (measured) but is the weaker element for PDFs on iOS, which is where a third
 * of the clicks on this button come from. Instead the blank frame is
 * signposted: a line below it names the escape hatch unconditionally, so a
 * member in front of an empty rectangle is told what to do rather than left to
 * guess.
 *
 * When canEditDate is true, onSetDate is provided, and the cert has no
 * completion date, a date-entry form appears in the footer so a compliance
 * manager can record the date read off the PDF. Saving also verifies the cert.
 *
 * When canVerify is true, onVerify is provided, and the cert already has a date
 * but no verified stamp (PENDING_VERIFICATION), a Verify button appears so a
 * compliance manager or admin can attest the cert after reviewing the PDF.
 *
 * Reject sits beside Verify because it is the other half of the same decision,
 * taken at the same moment by the same person with the PDF open in front of
 * them. It is offered on ANY certificate that is not already rejected, including
 * a verified one, because "we verified it and then noticed it was the wrong
 * person" has no other remedy -- and because that is genuinely destructive, a
 * verified cert also gets a warning naming the consequence before the manager
 * commits. Every other control is withdrawn once a certificate is rejected:
 * verifying or dating a refused file would write a stamp that changes nothing,
 * which reads as a broken button.
 */
export function CertificateViewer({
  certId,
  fileName,
  ownerName,
  completionDate,
  canEditDate,
  canEditExistingDate,
  onSetDate,
  canVerify,
  verified,
  onVerify,
  canReject,
  rejected,
  onReject,
  onUndoReject,
}: CertificateViewerProps) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const zone = useTimeZone();

  const inlineHref = `/my-info/certificate/${certId}?inline=1`;
  const downloadHref = `/my-info/certificate/${certId}`;
  const title = ownerName ? `${ownerName}: ${fileName}` : fileName;

  const hasDate = Boolean(completionDate);
  // Every accept-side control is withdrawn from a rejected certificate. Dating or
  // verifying one would write a stamp that changes nothing -- complianceStatus
  // reads the rejection first -- so the button would appear to work and have no
  // effect, which is worse than its absence.
  const canSetNew = Boolean(canEditDate && onSetDate && !hasDate && !rejected);
  const canOverwrite = Boolean(canEditExistingDate && onSetDate && hasDate && !rejected);
  const showForm = !rejecting && (canSetNew || (canOverwrite && editing));
  const isOverwrite = canOverwrite && editing;

  // Verify targets the PENDING_VERIFICATION case: a self-uploaded cert that has a
  // date but no verified stamp. Dateless certs verify via "Save and verify"
  // above; already-verified certs need no button.
  const canVerifyNow = Boolean(canVerify && onVerify && hasDate && !verified && !rejected);

  // Reject is offered whatever state the certificate is in, as long as it is not
  // already rejected: a dateless file that is obviously not a certificate should
  // not have to be given a completion date first just to be thrown out.
  const canRejectNow = Boolean(canReject && onReject && !rejected);
  const canUndoNow = Boolean(canReject && onUndoReject && rejected);
  // The consequence that makes this worth a warning: this certificate is what is
  // currently clearing the member, and rejecting it takes that away.
  const rejectingCleared = rejecting && Boolean(verified);

  const currentDateValue = completionDate
    ? completionDate.toISOString().split("T")[0]
    : undefined;

  function handleSubmit(formData: FormData) {
    if (!onSetDate) return;
    const dateIso = (formData.get("completionDate") as string | null) ?? "";
    setError(null);
    startTransition(async () => {
      // runAction, not a bare await: a rejected action would skip the error branch,
      // leave the modal open with no Alert, and lose the date the manager just read
      // off the PDF (audit 14).
      const result = await runAction(() => onSetDate(dateIso));
      if (result?.error) {
        setError(result.error);
        return;
      }
      setEditing(false);
      setOpen(false);
      router.refresh();
    });
  }

  function handleReject(formData: FormData) {
    if (!onReject) return;
    const reason = (formData.get("reason") as string | null) ?? "";
    const note = (formData.get("note") as string | null) ?? "";
    setError(null);
    startTransition(async () => {
      // runAction for the same reason the date form uses it: a rejected action
      // would otherwise skip the error branch and silently discard the reason
      // the manager just picked.
      const result = await runAction(() => onReject(reason, note));
      if (result?.error) {
        setError(result.error);
        return;
      }
      setRejecting(false);
      setOpen(false);
      router.refresh();
    });
  }

  function handleUndoReject() {
    if (!onUndoReject) return;
    setError(null);
    startTransition(async () => {
      const result = await runAction(() => onUndoReject());
      if (result?.error) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  function handleVerify() {
    if (!onVerify) return;
    setError(null);
    startTransition(async () => {
      const result = await runAction(() => onVerify());
      if (result?.error) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  // Clinic-local YYYY-MM-DD so the date input's max matches the clinic's "today".
  const today = formatForDateInput(new Date(), zone);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => {
          setError(null);
          setEditing(false);
          setRejecting(false);
          setOpen(true);
        }}
      >
        <Eye className="h-4 w-4" />
        View
      </Button>

      {open && (
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title={title}
          footer={
            <div className="flex w-full items-end justify-between gap-3">
              {showForm ? (
                <form action={handleSubmit}>
                  <FormRow>
                  <RowField label="Completion date">
                    <Input
                      type="date"
                      name="completionDate"
                      required
                      max={today}
                      defaultValue={isOverwrite ? currentDateValue : undefined}
                    />
                  </RowField>
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    disabled={isPending}
                  >
                    {isPending ? "Saving…" : isOverwrite ? "Update and verify" : "Save and verify"}
                  </Button>
                  {isOverwrite && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditing(false);
                        setError(null);
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                  </FormRow>
                </form>
              ) : rejecting ? (
                <form action={handleReject}>
                  <FormRow>
                    <RowField label="Reason" width="wide">
                      {/* Presets rather than free text alone: the member's email
                          is written from whichever one is picked, so it stays a
                          complete explanation even when the note is left empty. */}
                      <Select name="reason" required defaultValue={REJECTION_REASONS[0].value}>
                        {REJECTION_REASONS.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.staffLabel}
                          </option>
                        ))}
                      </Select>
                    </RowField>
                    <RowField label="Note to the member (optional)" width="wide">
                      <Input
                        name="note"
                        maxLength={REJECTION_NOTE_MAX}
                        placeholder="e.g. this is the Workday transcript"
                      />
                    </RowField>
                    <Button type="submit" variant="danger" size="sm" disabled={isPending}>
                      {isPending ? "Rejecting…" : "Reject"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setRejecting(false);
                        setError(null);
                      }}
                    >
                      Cancel
                    </Button>
                  </FormRow>
                </form>
              ) : canOverwrite || canVerifyNow || canRejectNow || canUndoNow ? (
                <div className="flex items-center gap-2">
                  {canOverwrite && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setError(null);
                        setEditing(true);
                      }}
                    >
                      Edit date
                    </Button>
                  )}
                  {canRejectNow && (
                    // Outline, not danger: it sits beside Verify as one of two
                    // ordinary outcomes of reading the PDF, and the destructive
                    // styling belongs on the confirm step, where the warning is.
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setError(null);
                        setEditing(false);
                        setRejecting(true);
                      }}
                    >
                      Reject
                    </Button>
                  )}
                  {canUndoNow && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isPending}
                      onClick={handleUndoReject}
                    >
                      {isPending ? "Restoring…" : "Undo rejection"}
                    </Button>
                  )}
                  {canVerifyNow && (
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      disabled={isPending}
                      onClick={handleVerify}
                    >
                      {isPending ? "Verifying…" : "Verify"}
                    </Button>
                  )}
                </div>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <a
                  href={inlineHref}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonClasses("ghost", "sm")}
                >
                  Open in new tab
                </a>
                <a href={downloadHref} className={buttonClasses("outline", "sm")}>
                  Download
                </a>
              </div>
            </div>
          }
        >
          {error && (
            <Alert tone="error" className="mb-2">{error}</Alert>
          )}
          {/* Rejecting reaches verified certificates on purpose, which means it
              can un-clear an active member mid-term. Naming that here, rather
              than only in a confirm label, is what makes the reach safe to
              offer: the manager reads the consequence while looking at the
              document it applies to. */}
          {rejectingCleared && (
            <Alert tone="warning" className="mb-2">
              This certificate is verified and may be what is currently clearing this
              member. Rejecting it withdraws that clearance until they upload a
              replacement. You can undo this afterwards if it was a mistake.
            </Alert>
          )}
          <iframe
            src={inlineHref}
            title={`Certificate preview: ${fileName}`}
            className="h-[75vh] w-full rounded-lg border border-border"
          />
          {/* Unconditional, because the failure it covers cannot be detected: a
              PDF plugin paints nothing inside the frame while the load reports
              success, leaving a member in front of a blank panel with no reason
              to think the footer buttons would do any better. */}
          <p className="mt-2 text-xs text-subtle-foreground">
            Not seeing the certificate? Open it in a new tab or download it using
            the buttons below.
          </p>
        </Modal>
      )}
    </>
  );
}
