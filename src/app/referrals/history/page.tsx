import Link from "next/link";
import { ArrowLeft, History } from "lucide-react";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { listReferralsByState } from "@/modules/referrals/services/referrals";
import type { ReferralState } from "@prisma/client";

const STATE_LABELS: Record<ReferralState, string> = {
  ENTERED: "Entered",
  AWAITING_FC: "Awaiting free care",
  SCHEDULED: "Scheduled",
  COMPLETED: "Completed",
  CANCELLED_BY_PROVIDER: "Cancelled by provider",
  CANCELLED_OR_NO_SHOW: "Cancelled / no-show",
  CLOSED_DECLINED: "Closed / declined",
};

const STATE_TONE: Record<ReferralState, "default" | "brand" | "success" | "warning" | "critical"> = {
  ENTERED: "default",
  AWAITING_FC: "warning",
  SCHEDULED: "brand",
  COMPLETED: "success",
  CANCELLED_BY_PROVIDER: "critical",
  CANCELLED_OR_NO_SHOW: "critical",
  CLOSED_DECLINED: "default",
};

const TERMINAL_STATES: ReferralState[] = [
  "COMPLETED",
  "CANCELLED_BY_PROVIDER",
  "CANCELLED_OR_NO_SHOW",
  "CLOSED_DECLINED",
];

export default async function ReferralsHistoryPage() {
  const byState = await Promise.all(
    TERMINAL_STATES.map(async (state) => ({
      state,
      referrals: await listReferralsByState(state),
    }))
  );

  const totalClosed = byState.reduce((sum, group) => sum + group.referrals.length, 0);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Referral history"
        description="Completed, cancelled, and closed referrals."
        action={
          <Link
            href="/referrals"
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-semibold text-foreground transition hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to referrals
          </Link>
        }
      />

      <div className="flex items-center gap-3">
        <Badge tone="default">{totalClosed} total</Badge>
      </div>

      <div className="space-y-6">
        {byState.map(({ state, referrals }) => (
          <div key={state} className="rounded-2xl border border-border bg-surface shadow-sm overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div className="flex items-center gap-3">
                <History className="h-5 w-5 text-subtle-foreground" aria-hidden />
                <h2 className="text-base font-semibold text-foreground">{STATE_LABELS[state]}</h2>
                <Badge tone={STATE_TONE[state]}>{referrals.length}</Badge>
              </div>
            </div>

            {referrals.length === 0 ? (
              <p className="px-6 py-6 text-sm text-muted-foreground">No referrals in this state.</p>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {referrals.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/referrals/${r.id}`}
                      className="flex items-center justify-between gap-4 px-6 py-4 transition hover:bg-muted"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground">{r.patient.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {r.referralType === "MDIC" ? "MDIC" : "Education"} · {r.purpose}
                          {r.referringDepartment ? ` · ${r.referringDepartment.name}` : ""}
                        </p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}