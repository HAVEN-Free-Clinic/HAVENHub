"use server";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import {
  assignSubcommittees,
  SubcommitteeAssignError,
  type SubcommitteeChange,
} from "@/modules/recruitment/services/subcommittees";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";

/**
 * The Subcommittees page's single Save. Each row posts its dropdown as
 * `sub:<applicationId>` beside the value it rendered with, `was:<applicationId>`,
 * and only rows whose value moved are saved. Re-saving an untouched row would
 * restamp who assigned it and when, and write an audit row for a non-event.
 */
export async function assignSubcommitteesAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const changes: SubcommitteeChange[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("sub:")) continue;
    const applicationId = key.slice("sub:".length);
    const next = String(value);
    if (next === String(formData.get(`was:${applicationId}`) ?? "")) continue;
    changes.push({ applicationId, subcommitteeId: next === "" ? null : next });
  }

  const back = `/recruitment/cycles/${cycleId}/subcommittees`;
  if (changes.length === 0) redirect(back);
  try {
    await assignSubcommittees(cycleId, changes, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof SubcommitteeAssignError) {
      redirect(`${back}?error=${encodeURIComponent((err as Error).message)}`);
    }
    throw err;
  }
  redirect(`${back}?saved=1`);
}
