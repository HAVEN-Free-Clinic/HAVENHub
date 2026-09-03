"use server";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { resetTraining, TrainingStateError } from "@/modules/recruitment/services/training";
import {
  AttendanceEventError,
  ensureTrainingEventForCycle,
  recordEventCheckIn,
} from "@/modules/recruitment/services/attendance-events";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";
import { prisma } from "@/platform/db";
import type { Track } from "@prisma/client";

function bounce(cycleId: string, params: { msg?: string; err?: string }) {
  const q = new URLSearchParams();
  if (params.msg) q.set("msg", params.msg);
  if (params.err) q.set("err", params.err);
  return `/recruitment/cycles/${cycleId}/training?${q.toString()}`;
}

async function termAndTrackOfCycle(cycleId: string): Promise<{ termId: string; track: Track }> {
  const c = await prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: cycleId }, select: { termId: true, track: true } });
  return { termId: c.termId, track: c.track };
}

/**
 * The roster's per-row button, now routed through event check-in.
 *
 * Attendance lives on the event from here on (see services/attendance-events.ts),
 * with the Training completion as a consequence of it, so this path and the
 * kiosk write the same rows and one session's attendance cannot end up split
 * across two stores. The cycle's TRAINING event is created on first use from its
 * inPersonTrainingDate, so nobody has to have set one up by hand.
 */
export async function recordAttendanceAction(cycleId: string, personId: string) {
  const person = await requirePersonSession();
  try {
    const event = await ensureTrainingEventForCycle(cycleId, person.personId);
    await recordEventCheckIn(event.id, { kind: "person", personId }, person.personId);
  } catch (err) {
    if (
      err instanceof RecruitmentAuthError ||
      err instanceof TrainingStateError ||
      err instanceof AttendanceEventError
    ) {
      redirect(bounce(cycleId, { err: (err as Error).message }));
    }
    throw err;
  }
  redirect(bounce(cycleId, { msg: "Attendance recorded." }));
}

export async function resetTrainingAction(cycleId: string, personId: string) {
  const person = await requirePersonSession();
  try {
    const { termId, track } = await termAndTrackOfCycle(cycleId);
    await resetTraining(personId, termId, track, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof TrainingStateError) redirect(bounce(cycleId, { err: (err as Error).message }));
    throw err;
  }
  redirect(bounce(cycleId, { msg: "Training reset." }));
}
