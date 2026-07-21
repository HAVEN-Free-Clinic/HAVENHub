import { Alert } from "@/platform/ui/alert";
import { ConfirmButton } from "@/platform/ui/confirm-button";

/** Warns that a department's acceptance has already been emailed, and offers the
 *  SRR-only control to rescind it. Shared by the interview detail page and the
 *  routed applicant page: a routed decision taken without an interview has no
 *  interview screen, so both surfaces need this warning and control. Holding it in
 *  one component is what keeps the two rescind paths from drifting in wording.
 *
 *  `action` is a server action the caller has already bound, because the two pages
 *  reach different actions with different signatures. */
export function RescindAcceptanceNotice({
  departmentCode,
  canRescind,
  action,
}: {
  departmentCode: string;
  canRescind: boolean;
  action: () => Promise<void>;
}) {
  return (
    <div className="mt-3 space-y-3">
      <Alert tone="warning">
        This applicant has already been emailed their acceptance for {departmentCode}. Changing the decision to Reject or Waitlist is blocked until the acceptance is rescinded.{" "}
        {canRescind ? "Rescind it below, then record the new decision." : "Ask an SRR to rescind it first."}
      </Alert>
      {canRescind && (
        <form action={action}>
          <ConfirmButton label="Rescind acceptance" size="sm" />
        </form>
      )}
    </div>
  );
}
