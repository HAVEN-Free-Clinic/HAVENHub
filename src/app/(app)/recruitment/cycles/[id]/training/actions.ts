"use server";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { recordAttendance, resetTraining, TrainingStateError } from "@/modules/recruitment/services/training";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";
import { prisma } from "@/platform/db";

function bounce(cycleId: string, params: { msg?: string; err?: string }) {
  const q = new URLSearchParams();
  if (params.msg) q.set("msg", params.msg);
  if (params.err) q.set("err", params.err);
  return `/recruitment/cycles/${cycleId}/training?${q.toString()}`;
}

async function termOfCycle(cycleId: string): Promise<string> {
  const c = await prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: cycleId }, select: { termId: true } });
  return c.termId;
}

export async function recordAttendanceAction(cycleId: string, personId: string) {
  const person = await requirePersonSession();
  try {
    await recordAttendance(personId, await termOfCycle(cycleId), person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof TrainingStateError) redirect(bounce(cycleId, { err: (err as Error).message }));
    throw err;
  }
  redirect(bounce(cycleId, { msg: "Attendance recorded." }));
}

export async function resetTrainingAction(cycleId: string, personId: string) {
  const person = await requirePersonSession();
  try {
    await resetTraining(personId, await termOfCycle(cycleId), person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof TrainingStateError) redirect(bounce(cycleId, { err: (err as Error).message }));
    throw err;
  }
  redirect(bounce(cycleId, { msg: "Training reset." }));
}
