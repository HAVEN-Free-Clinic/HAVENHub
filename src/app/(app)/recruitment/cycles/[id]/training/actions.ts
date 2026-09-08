"use server";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import {
  clearAbsenceExcuse,
  recordAbsenceExcuse,
  resetTraining,
  TrainingStateError,
} from "@/modules/recruitment/services/training";
import {
  AttendanceEventError,
  ensureTrainingEventForCycle,
  recordEventCheckIn,
} from "@/modules/recruitment/services/attendance-events";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";
import { prisma } from "@/platform/db";
import type { Track } from "@prisma/client";

/**
 * Params are `saved` and `error` because those are the two names the flash-toast
 * classifier claims (src/platform/ui/toast/flash.ts). The `msg`/`err` pair this
 * used to send was claimed by nothing, so every one of these redirects landed
 * silently: attendance was recorded and the roster just re-rendered. `error`
 * carries its text through by convention; each `saved` value has a registry entry
 * scoped to this page.
 */
function bounce(cycleId: string, params: { saved?: string; error?: string }) {
  const q = new URLSearchParams();
  if (params.saved) q.set("saved", params.saved);
  if (params.error) q.set("error", params.error);
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
      redirect(bounce(cycleId, { error: (err as Error).message }));
    }
    throw err;
  }
  redirect(bounce(cycleId, { saved: "attendance" }));
}

/**
 * Turn this machine into the door for this cycle's training session.
 *
 * An action rather than a plain link because the TRAINING event may not exist
 * yet: nobody should have to go and create one before taking attendance, and
 * ensureTrainingEventForCycle is idempotent, so the button is safe to press
 * every session and by two leads at once.
 */
export async function startCheckInAction(cycleId: string) {
  const person = await requirePersonSession();
  let eventId: string;
  try {
    const event = await ensureTrainingEventForCycle(cycleId, person.personId);
    eventId = event.id;
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof AttendanceEventError) {
      redirect(bounce(cycleId, { error: (err as Error).message }));
    }
    throw err;
  }
  // Outside the try: redirect throws, and catching it here would turn a
  // successful navigation into the error flash above.
  redirect(`/check-in/${eventId}`);
}

export async function resetTrainingAction(cycleId: string, personId: string) {
  const person = await requirePersonSession();
  try {
    const { termId, track } = await termAndTrackOfCycle(cycleId);
    await resetTraining(personId, termId, track, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof TrainingStateError) redirect(bounce(cycleId, { error: (err as Error).message }));
    throw err;
  }
  redirect(bounce(cycleId, { saved: "reset" }));
}

/**
 * Write down an absence the person excused by email before the session.
 *
 * Reads the reason off the row's own form. Failure comes back as `error` rather
 * than being swallowed: the reason is required, and a blank submit that quietly
 * did nothing would look exactly like a saved excuse.
 */
export async function excuseAbsenceAction(cycleId: string, personId: string, formData: FormData) {
  const person = await requirePersonSession();
  try {
    await recordAbsenceExcuse(cycleId, personId, String(formData.get("reason") ?? ""), person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof TrainingStateError) {
      redirect(bounce(cycleId, { error: (err as Error).message }));
    }
    throw err;
  }
  redirect(bounce(cycleId, { saved: "excused" }));
}

export async function clearExcuseAction(cycleId: string, personId: string) {
  const person = await requirePersonSession();
  try {
    await clearAbsenceExcuse(cycleId, personId, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof TrainingStateError) {
      redirect(bounce(cycleId, { error: (err as Error).message }));
    }
    throw err;
  }
  redirect(bounce(cycleId, { saved: "excuse-cleared" }));
}
