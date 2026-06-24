"use server";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { recordAttendance, resetTraining, TrainingStateError } from "@/modules/recruitment/services/training";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";
import { prisma } from "@/platform/db";
import type { TrainingTrack } from "@prisma/client";

function bounce(cycleId: string, params: { msg?: string; err?: string }) {
  const q = new URLSearchParams();
  if (params.msg) q.set("msg", params.msg);
  if (params.err) q.set("err", params.err);
  return `/recruitment/cycles/${cycleId}/training?${q.toString()}`;
}

async function termAndTrackOfCycle(cycleId: string): Promise<{ termId: string; track: TrainingTrack }> {
  const c = await prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: cycleId }, select: { termId: true, track: true } });
  return { termId: c.termId, track: c.track };
}

export async function recordAttendanceAction(cycleId: string, personId: string) {
  const person = await requirePersonSession();
  try {
    const { termId, track } = await termAndTrackOfCycle(cycleId);
    await recordAttendance(personId, termId, track, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof TrainingStateError) redirect(bounce(cycleId, { err: (err as Error).message }));
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
