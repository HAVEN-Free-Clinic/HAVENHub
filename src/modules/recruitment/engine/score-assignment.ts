/** One (application, scorer) edge. The same shape carries an assignment and a
 *  recorded score, because CommitteeScore and ScoreAssignment share a key. */
export type AssignmentPair = { applicationId: string; scorerId: string };

export type AllocateInput = {
  /** Applications still open to committee scoring, in roster order. The
   *  allocator touches NOTHING outside this list, so a routed or decided
   *  application keeps whatever assignments it already had. */
  applications: { id: string; applicantPersonId: string | null }[];
  /** The cycle's scorer pool. */
  scorerIds: string[];
  /** How many distinct scorers each application should be read by. */
  target: number;
  /** Assignments that exist right now. */
  existing: AssignmentPair[];
  /** Scores already recorded, by anyone, pool member or not. */
  scored: AssignmentPair[];
};

export type AllocateResult = { add: AssignmentPair[]; remove: AssignmentPair[] };

function fnv1a(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** murmur3 finalizer: the avalanche step that makes one changed input bit flip
 *  half the output bits. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Stable pseudo-random order for one (scorer, application) pair. Deterministic
 * and dependency-free: the same pool and roster must produce the same division
 * every time the lead presses the button, or a re-run would shuffle everyone's
 * queue underneath them.
 *
 * The avalanche is load-bearing, not decoration. A plain polynomial hash such
 * as djb2 is very nearly linear over short similar strings, so for a fixed
 * application the gap between two scorer ids stays a constant multiple of the
 * base and the pool comes back in alphabetical order every single time. That
 * defeats the whole point of the tie-break: with `target` 2 the same two people
 * get paired on application after application, and each applicant is read by
 * one of a few fixed duos instead of a mixed panel. Verified with real ids of
 * the shape this receives.
 */
function tieBreak(scorerId: string, applicationId: string): number {
  return fmix32(fnv1a(scorerId) ^ Math.imul(fnv1a(applicationId), 0x9e3779b1));
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

/**
 * Divide a cycle's applications among its scorer pool so each one is read by
 * `target` people.
 *
 * Incremental by design: run it after every pool or roster change and it tops
 * up what is short without disturbing what is already settled. Two rules make
 * that safe.
 *
 * A recorded score is never undone. It counts toward the target even when its
 * author is outside the pool (a lead scoring from the detail page is a real
 * review), and an assignment that has been scored survives its author leaving
 * the pool. Only unscored work moves.
 *
 * Nobody scores their own application, and the target clamps to the number of
 * scorers who could actually cover it, so a pool of two with a target of three
 * silently settles for two rather than failing or forcing a self-score.
 */
export function allocateAssignments(input: AllocateInput): AllocateResult {
  const pool = input.scorerIds;
  const inPool = new Set(pool);
  const eligible = new Set(input.applications.map((a) => a.id));

  const scoredBy = new Map<string, Set<string>>();
  for (const s of input.scored) {
    if (eligible.has(s.applicationId)) addTo(scoredBy, s.applicationId, s.scorerId);
  }

  const assignedBy = new Map<string, Set<string>>();
  const load = new Map<string, number>();
  const remove: AssignmentPair[] = [];
  for (const e of input.existing) {
    if (!eligible.has(e.applicationId)) continue;
    if (!inPool.has(e.scorerId) && !scoredBy.get(e.applicationId)?.has(e.scorerId)) {
      remove.push(e);
      continue;
    }
    addTo(assignedBy, e.applicationId, e.scorerId);
    load.set(e.scorerId, (load.get(e.scorerId) ?? 0) + 1);
  }

  const target = Math.max(0, Math.trunc(input.target));
  const add: AssignmentPair[] = [];
  for (const application of input.applications) {
    const covered = new Set([
      ...(assignedBy.get(application.id) ?? []),
      ...(scoredBy.get(application.id) ?? []),
    ]);
    const candidates = pool.filter((s) => s !== application.applicantPersonId && !covered.has(s));
    const deficit = Math.min(target, covered.size + candidates.length) - covered.size;
    if (deficit <= 0) continue;
    // Least loaded first, so the piles come out even. The hash decides ties:
    // ordering them by id instead would pair the same scorers together on
    // every application, giving each applicant one of a few fixed duos rather
    // than a mixed panel.
    const ordered = candidates.slice().sort(
      (a, b) =>
        (load.get(a) ?? 0) - (load.get(b) ?? 0) ||
        tieBreak(a, application.id) - tieBreak(b, application.id) ||
        (a < b ? -1 : 1),
    );
    for (const scorerId of ordered.slice(0, deficit)) {
      add.push({ applicationId: application.id, scorerId });
      load.set(scorerId, (load.get(scorerId) ?? 0) + 1);
    }
  }
  return { add, remove };
}

