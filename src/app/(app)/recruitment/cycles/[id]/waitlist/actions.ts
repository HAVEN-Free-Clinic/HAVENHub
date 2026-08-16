"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/platform/db";
import { requirePersonSession } from "@/platform/auth/session";
import { RecruitmentAuthError, AcceptanceError } from "@/modules/recruitment/services/review";
import { decideInterview } from "@/modules/recruitment/services/interview-decisions";
import { InterviewError } from "@/modules/recruitment/services/interviews";
import { decideRoutedApplication, RoutingError } from "@/modules/recruitment/services/routing";
import { sendAcceptanceEmail } from "@/modules/recruitment/services/decisions";

function bounce(cycleId: string, opts?: { error?: string; promoted?: string; sent?: string }) {
  const base = `/recruitment/cycles/${cycleId}/waitlist`;
  if (opts?.error) return `${base}?error=${encodeURIComponent(opts.error)}`;
  if (opts?.promoted) {
    const params = new URLSearchParams({ promoted: opts.promoted });
    if (opts.sent) params.set("sent", opts.sent);
    return `${base}?${params.toString()}`;
  }
  return base;
}

/**
 * Promote a waitlisted applicant to ACCEPT. This is a thin dispatcher over the
 * existing decide functions: for a director-track waitlist we flip the specific
 * Interview (identified by interviewId); for a volunteer-track waitlist we flip
 * the routed Application. Both mint the Acceptance and enforce scope, separation
 * of duties, and the emailed/contract guard (none of which block WAITLIST->ACCEPT,
 * since a waitlisted applicant has no Acceptance to protect). The decide step
 * mints the Acceptance; the acceptance email is then sent immediately by
 * sendAcceptanceEmail (idempotent -- a later "Release decisions" won't re-send).
 * A conflicted applicant (offers from >1 department) is promoted but NOT emailed
 * until the conflict is resolved and the cycle released; the caller is told so.
 */
export async function promoteFromWaitlistAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  // Refuse the whole promote on an archived cycle, BEFORE the decide step. Every
  // other half of this flow is already blocked once a cycle is archived --
  // sendAcceptanceEmail refuses, and createOrResendContract refuses the onboarding
  // link the acceptance promises -- so going ahead would flip the applicant to
  // ACCEPT and mint an Acceptance that can never be notified or onboarded, which is
  // strictly worse for them than staying on the waitlist. Un-archiving is the way
  // through (see unarchiveCycle), so the message says so (audit 14, REC-5).
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId }, select: { status: true } });
  if (cycle?.status === "ARCHIVED") {
    redirect(bounce(cycleId, {
      error: "This cycle is archived, so an acceptance could not be emailed or onboarded. Un-archive it from the cycle overview first.",
    }));
  }
  const applicationIdInput = String(formData.get("applicationId") ?? "").trim();
  const interviewId = String(formData.get("interviewId") ?? "").trim() || null;
  const name = String(formData.get("applicantName") ?? "").trim() || "Applicant";
  let applicationId: string;
  let departmentCode: string;
  try {
    if (interviewId) {
      const iv = await decideInterview(interviewId, "ACCEPT", person.personId, null);
      applicationId = iv.applicationId;
      departmentCode = iv.departmentCode;
    } else {
      const app = await decideRoutedApplication(applicationIdInput, "ACCEPT", person.personId, null);
      applicationId = app.id;
      departmentCode = app.routedDepartmentCode ?? "";
    }
  } catch (err) {
    if (
      err instanceof RecruitmentAuthError ||
      err instanceof AcceptanceError ||
      err instanceof RoutingError ||
      err instanceof InterviewError
    ) {
      redirect(bounce(cycleId, { error: err.message }));
    }
    throw err;
  }
  const notify = await sendAcceptanceEmail(applicationId, departmentCode);
  revalidatePath(bounce(cycleId));
  redirect(bounce(cycleId, { promoted: name, sent: notify.sent ? "1" : (notify.reason ?? "0") }));
}
