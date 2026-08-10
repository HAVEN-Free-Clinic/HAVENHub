/**
 * Pure row model for the recruitment onboarding table.
 *
 * Every function here is deterministic and takes `now` explicitly, so row state
 * (including link expiry) is resolved once on the server and never recomputed
 * during client render.
 */

export type OnboardingRowState =
  | "NO_CONTRACT"
  | "SENT"
  | "EXPIRED"
  | "SUBMITTED"
  | "PROMOTED"
  | "CONFLICT";

export type OnboardingBulkAction = "send" | "promote" | "withdraw";

export type OnboardingRow = {
  acceptanceId: string;
  contractId: string | null;
  firstName: string;
  lastName: string;
  departmentCode: string;
  state: OnboardingRowState;
  onRoster: boolean;
  customAnswers: { label: string; value: string }[];
};

export type OnboardingFilters = {
  query: string;
  status: OnboardingRowState | "ALL";
  dept: string | "ALL";
};

/**
 * Resolve the single state a row is in.
 *
 * CONFLICT wins over every contract state: an application accepted by more than
 * one department cannot be onboarded or promoted until SRR resolves it on the
 * Decisions page, no matter how far its contract got.
 *
 * Expiry only distinguishes SENT from EXPIRED, because it only gates the window
 * in which an applicant may still submit. A null expiresAt is grandfathered as
 * non-expiring (contracts predate the column).
 */
export function deriveRowState(input: {
  conflicted: boolean;
  contract: { status: string; expiresAt: Date | null } | null;
  now: Date;
}): OnboardingRowState {
  if (input.conflicted) return "CONFLICT";
  const c = input.contract;
  if (!c) return "NO_CONTRACT";
  if (c.status === "PROMOTED") return "PROMOTED";
  if (c.status === "SUBMITTED") return "SUBMITTED";
  const expired = c.expiresAt != null && c.expiresAt.getTime() < input.now.getTime();
  return expired ? "EXPIRED" : "SENT";
}

const ELIGIBLE_STATES: Record<OnboardingBulkAction, readonly OnboardingRowState[]> = {
  // createOrResendContract refuses any contract that is not PENDING.
  send: ["NO_CONTRACT", "SENT", "EXPIRED"],
  promote: ["SUBMITTED"],
  // withdrawContract refuses PROMOTED (that reversal is offboarding).
  withdraw: ["SENT", "EXPIRED", "SUBMITTED"],
};

export function isEligible(action: OnboardingBulkAction, state: OnboardingRowState): boolean {
  return ELIGIBLE_STATES[action].includes(state);
}

/** A row is selectable when at least one bulk action could act on it. Rows that
 *  fail this render no checkbox, so select-all never picks up dead weight. */
export function isSelectable(state: OnboardingRowState): boolean {
  return (["send", "promote", "withdraw"] as const).some((a) => isEligible(a, state));
}

export function filterRows(rows: OnboardingRow[], filters: OnboardingFilters): OnboardingRow[] {
  const q = filters.query.trim().toLowerCase();
  return rows.filter((r) => {
    if (filters.status !== "ALL" && r.state !== filters.status) return false;
    if (filters.dept !== "ALL" && r.departmentCode !== filters.dept) return false;
    if (q === "") return true;
    return `${r.firstName} ${r.lastName}`.toLowerCase().includes(q);
  });
}

export function countEligible(rows: OnboardingRow[], action: OnboardingBulkAction): number {
  return rows.reduce((n, r) => (isEligible(action, r.state) ? n + 1 : n), 0);
}
