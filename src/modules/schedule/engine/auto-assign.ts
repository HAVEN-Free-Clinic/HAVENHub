/**
 * Proposes volunteer shift assignments for one department's term.
 *
 * Pure and I/O free, for the same reason capacity.ts and board-totals.ts are:
 * the builder board is a client component, and the proposal has to be explainable
 * without a database round trip. Everything it needs is resolved by the caller
 * and handed in.
 *
 * It only ever ADDS. An assignment a human placed is never moved or removed,
 * because the director is the authority on their own board and a generator that
 * quietly rearranges last week's decisions is one nobody will run twice.
 */

/** One schedulable person. `id` is a personId, or a provisional row id for an
 *  accepted applicant who has no Person yet. */
export type AutoAssignMember = {
  id: string;
  /** Resolved availability, already narrowed to the term's open clinic dates. */
  availableDateKeys: readonly string[];
  /** Shifts they asked for this term. Null when they never said. */
  requestedShifts: number | null;
  /** Verified Spanish proficiency, or null when unscored or unassessable. */
  interpreterScore: number | null;
  /** Dates they are already committed to in ANOTHER department. */
  conflictDateKeys: readonly string[];
};

export type AutoAssignInput = {
  /** Open clinic dates, in calendar order. Closed dates must not appear. */
  dateKeys: readonly string[];
  members: readonly AutoAssignMember[];
  /** dateKey -> member ids already on the board that date, in ANY role. */
  alreadyAssigned: Readonly<Record<string, readonly string[]>>;
  /** dateKey -> how many already count toward the cap. */
  volunteersOnDate: Readonly<Record<string, number>>;
  /** Max volunteers per date. Null means uncapped. */
  cap: number | null;
  /** Lowest interpreter score that counts as covering the date. Null means the
   *  department expresses no preference. */
  interpreterBar: number | null;
  /** Shifts to assume for a member who never stated a number. */
  fallbackRequestedShifts: number;
};

export type AutoAssignAddition = { dateKey: string; memberId: string };

/** How one clinic date came out, so a director can see why it looks the way it does. */
export type AutoAssignDateReport = {
  dateKey: string;
  /** How many people could ever cover this date, before anything was placed. */
  available: number;
  before: number;
  after: number;
  cap: number | null;
  /** Seats left empty against the cap. Read it beside `available`: a date short
   *  by 12 with only 8 people available is staffed as fully as it can be. */
  shortBy: number;
  /** Whether the date ends up with somebody at the department's interpreter bar.
   *  UNKNOWN means the only people on it have no assessed score, which is the
   *  common case for a first-time applicant and is not a failing. */
  interpreterCover: "AT_BAR" | "BELOW_BAR" | "UNKNOWN" | "NONE";
};

/** What one person got, against what they asked for. */
export type AutoAssignMemberReport = {
  memberId: string;
  /** Their own answer, null when they never gave one. */
  requested: number | null;
  before: number;
  after: number;
};

export type AutoAssignProposal = {
  additions: readonly AutoAssignAddition[];
  dates: readonly AutoAssignDateReport[];
  members: readonly AutoAssignMemberReport[];
};

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function autoAssign(input: AutoAssignInput): AutoAssignProposal {
  const { dateKeys, cap, interpreterBar } = input;

  // Sorted once, so the proposal never depends on the order rows happened to
  // come out of the database. Every tie below falls through to this order.
  const members = [...input.members].sort(byId);
  const lookup = new Map(members.map((m) => [m.id, m]));
  const limitOf = (m: AutoAssignMember) => m.requestedShifts ?? input.fallbackRequestedShifts;
  const atBar = (m: AutoAssignMember | undefined) =>
    interpreterBar !== null && m != null && m.interpreterScore !== null && m.interpreterScore >= interpreterBar;

  // Seed from the board as it stands.
  const onDate = new Map<string, Set<string>>();
  const filled = new Map<string, number>();
  const held = new Map<string, number>();
  for (const dateKey of dateKeys) {
    const ids = new Set(input.alreadyAssigned[dateKey] ?? []);
    onDate.set(dateKey, ids);
    filled.set(dateKey, input.volunteersOnDate[dateKey] ?? 0);
    // Shifts already on someone's row count toward what they asked for. Without
    // this, a generate run on a part-built board hands the busiest people more.
    for (const id of ids) held.set(id, (held.get(id) ?? 0) + 1);
  }
  const heldBefore = new Map(held);
  const filledBefore = new Map(filled);

  const canWork = (m: AutoAssignMember, dateKey: string) =>
    m.availableDateKeys.includes(dateKey) &&
    // Committed elsewhere that Saturday. A person can only be in one place.
    !m.conflictDateKeys.includes(dateKey) &&
    !onDate.get(dateKey)!.has(m.id);

  // Static scarcity, measured before anything is placed: how many people could
  // ever cover this date.
  const available = new Map<string, number>();
  for (const dateKey of dateKeys) {
    available.set(dateKey, members.filter((m) => canWork(m, dateKey)).length);
  }

  const covered = new Map<string, boolean>();
  for (const dateKey of dateKeys) {
    covered.set(dateKey, [...onDate.get(dateKey)!].some((id) => atBar(lookup.get(id))));
  }

  // Scarcest first, so a Saturday only a handful can work is filled before one
  // everybody can, instead of losing its few candidates to an easy date.
  const order = [...dateKeys].sort((a, b) => {
    const d = (available.get(a) ?? 0) - (available.get(b) ?? 0);
    return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
  });

  const additions: AutoAssignAddition[] = [];

  // One shift per person per round, so nobody collects a second Saturday while
  // somebody else is still short of their first.
  let progressed = true;
  while (progressed) {
    progressed = false;
    const usedThisRound = new Set<string>();

    for (const dateKey of order) {
      if (cap !== null && (filled.get(dateKey) ?? 0) >= cap) continue;

      const candidates = members.filter(
        (m) =>
          !usedThisRound.has(m.id) &&
          (held.get(m.id) ?? 0) < limitOf(m) &&
          canWork(m, dateKey),
      );
      if (candidates.length === 0) continue;

      const wantsBar = interpreterBar !== null && !covered.get(dateKey);
      candidates.sort((a, b) => {
        // Furthest below what they asked for goes first.
        const da = limitOf(a) - (held.get(a.id) ?? 0);
        const db = limitOf(b) - (held.get(b.id) ?? 0);
        if (da !== db) return db - da;
        // A preference, never a filter: it only reorders people who are all
        // equally owed a shift, and it is skipped once the date has cover.
        if (wantsBar) {
          const ba = atBar(a) ? 1 : 0;
          const bb = atBar(b) ? 1 : 0;
          if (ba !== bb) return bb - ba;
        }
        const ha = held.get(a.id) ?? 0;
        const hb = held.get(b.id) ?? 0;
        if (ha !== hb) return ha - hb;
        return byId(a, b);
      });

      const pick = candidates[0];
      additions.push({ dateKey, memberId: pick.id });
      onDate.get(dateKey)!.add(pick.id);
      filled.set(dateKey, (filled.get(dateKey) ?? 0) + 1);
      held.set(pick.id, (held.get(pick.id) ?? 0) + 1);
      usedThisRound.add(pick.id);
      if (atBar(pick)) covered.set(dateKey, true);
      progressed = true;
    }
  }

  const dates: AutoAssignDateReport[] = dateKeys.map((dateKey) => {
    const after = filled.get(dateKey) ?? 0;
    const ids = [...onDate.get(dateKey)!];
    const scored = ids.map((id) => lookup.get(id)).filter((m) => m != null);
    const interpreterCover: AutoAssignDateReport["interpreterCover"] =
      ids.length === 0
        ? "NONE"
        : covered.get(dateKey)
          ? "AT_BAR"
          : scored.some((m) => m!.interpreterScore !== null)
            ? "BELOW_BAR"
            : "UNKNOWN";
    return {
      dateKey,
      available: available.get(dateKey) ?? 0,
      before: filledBefore.get(dateKey) ?? 0,
      after,
      cap,
      shortBy: cap === null ? 0 : Math.max(0, cap - after),
      interpreterCover,
    };
  });

  const memberReports: AutoAssignMemberReport[] = members.map((m) => ({
    memberId: m.id,
    requested: m.requestedShifts,
    before: heldBefore.get(m.id) ?? 0,
    after: held.get(m.id) ?? 0,
  }));

  return { additions, dates, members: memberReports };
}
