/**
 * What a volunteer owes on training day, and the one writer of it.
 *
 * Training day has two parts: the morning session and the afternoon mock
 * clinic. Each is OWED, NOT_REQUIRED, or satisfied (attended, made up online,
 * marked off). A Training row is COMPLETE exactly when neither part is OWED,
 * which is what lets every existing reader of Training.status (the get-started
 * gate, clearance, the dashboard, reminders, the roster) enforce these rules
 * without knowing them.
 *
 * Lives in platform, not recruitment, because three modules change the facts
 * it reads: recruitment (check-ins, IT mark-offs), learning (the online makeup
 * course), and the reminders sweep. Modules may not import each other.
 *
 * WIP contract stub: the implementation lands in the same PR.
 */
import type { Track } from "@prisma/client";
import type { TransactionClient } from "@/platform/db";
import { prisma } from "@/platform/db";

type Db = TransactionClient | typeof prisma;

/** Where a person stands on a training cycle's online makeup course. */
export type MakeupAccess = {
  /** OWED: their morning is owed, so the course is theirs to take.
   *  DONE: they finished it (morningStatus ONLINE_COURSE).
   *  NOT_OWED: anything else (attended, clinical, not a member). */
  status: "OWED" | "DONE" | "NOT_OWED";
  /** The cycle's term: makeup progress is recorded against it, never against
   *  the active term, so a returning member can finish before the switch. */
  termId: string;
  track: Track;
  /** 3 failed tries on a section quiz lock the makeup, exactly like the retired
   *  quiz did; a director clears it with the training roster's Reset. */
  locked: boolean;
  /** Only attempts at or after this instant count toward the lock. */
  lockResetAt: Date | null;
};

/** Where `personId` stands on `cycleId`'s makeup course. */
export async function getMakeupAccess(personId: string, cycleId: string): Promise<MakeupAccess> {
  void personId;
  void cycleId;
  throw new Error("not implemented");
}

/** Lock the person's makeup after the last allowed failed attempt. */
export async function lockMakeup(db: Db, personId: string, cycleId: string): Promise<void> {
  void db;
  void personId;
  void cycleId;
  throw new Error("not implemented");
}

/** Recompute both parts and the rollup from the facts, and persist them.
 *  Idempotent. Call after anything that changes a fact: a check-in, a
 *  course completion, a mark-off, a promotion, a department change. */
export async function recomputeTrainingStanding(
  db: Db,
  args: { personId: string; termId: string; track: Track }
): Promise<void> {
  void db;
  void args;
  throw new Error("not implemented");
}
