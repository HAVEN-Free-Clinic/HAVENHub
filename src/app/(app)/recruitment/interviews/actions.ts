"use server";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { parseZonedInput } from "@/platform/dates";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { updateInterview, addPanelist, removePanelist, sendInterviewInvite, InterviewError } from "@/modules/recruitment/services/interviews";
import { decideInterview, type InterviewOutcome } from "@/modules/recruitment/services/interview-decisions";
import { RecruitmentAuthError, AcceptanceError, revokeAcceptance } from "@/modules/recruitment/services/review";
import { submitEvaluation } from "@/modules/recruitment/services/evaluations";

// The interview detail page now lives at /recruitment/interviews/[id] (outside the
// recruitment-staff gate) so panelists can reach it. These actions self-authorize
// at the service layer (panel membership for the evaluation; review scope for the
// management actions), so they never depended on the layout gate.
function detail(interviewId: string, opts?: { error?: string; saved?: string }) {
  const base = `/recruitment/interviews/${interviewId}`;
  if (opts?.error) return `${base}?error=${encodeURIComponent(opts.error)}`;
  if (opts?.saved) return `${base}?saved=${encodeURIComponent(opts.saved)}`;
  return base;
}
function isDomain(err: unknown) {
  return err instanceof RecruitmentAuthError || err instanceof AcceptanceError || err instanceof InterviewError;
}

export async function scheduleAction(interviewId: string, formData: FormData) {
  const person = await requirePersonSession();
  const rawAt = String(formData.get("scheduledAt") ?? "").trim();
  const scheduledAt = rawAt ? parseZonedInput(rawAt, await getDisplayTimeZone()) : null;
  const zoomLink = String(formData.get("zoomLink") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  try { await updateInterview(interviewId, { scheduledAt, zoomLink, notes }, person.personId); }
  catch (err) { if (isDomain(err)) redirect(detail(interviewId, { error: (err as Error).message })); throw err; }
  redirect(detail(interviewId, { saved: "schedule" }));
}

export async function addPanelistAction(interviewId: string, formData: FormData) {
  const person = await requirePersonSession();
  const personId = String(formData.get("personId") ?? "").trim();
  const isLead = formData.get("isLead") === "on";
  try { await addPanelist(interviewId, personId, isLead, person.personId); }
  catch (err) { if (isDomain(err)) redirect(detail(interviewId, { error: (err as Error).message })); throw err; }
  redirect(detail(interviewId, { saved: "panelist" }));
}

export async function removePanelistAction(interviewId: string, panelistId: string) {
  const person = await requirePersonSession();
  try { await removePanelist(panelistId, person.personId); }
  catch (err) { if (isDomain(err)) redirect(detail(interviewId, { error: (err as Error).message })); throw err; }
  redirect(detail(interviewId, { saved: "panelist" }));
}

export async function sendInviteAction(interviewId: string) {
  const person = await requirePersonSession();
  try { await sendInterviewInvite(interviewId, person.personId); }
  catch (err) { if (isDomain(err)) redirect(detail(interviewId, { error: (err as Error).message })); throw err; }
  redirect(detail(interviewId, { saved: "invite" }));
}

export async function decideAction(interviewId: string, formData: FormData) {
  const person = await requirePersonSession();
  const outcome = String(formData.get("outcome") ?? "") as InterviewOutcome;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (!(["ACCEPT", "REJECT", "WAITLIST"] as InterviewOutcome[]).includes(outcome)) {
    redirect(detail(interviewId, { error: "Invalid outcome." }));
  }
  try { await decideInterview(interviewId, outcome, person.personId, notes); }
  catch (err) { if (isDomain(err)) redirect(detail(interviewId, { error: (err as Error).message })); throw err; }
  redirect(detail(interviewId, { saved: "decision" }));
}

// Rescind a notified acceptance straight from the interview screen so an SRR can
// walk back an emailed offer here (decideInterview blocks the decision change
// until the acceptance is gone; issue #77). revokeAcceptance self-authorizes:
// only review_all may delete an emailed acceptance, a director is told to ask SRR.
export async function rescindAcceptanceAction(interviewId: string, acceptanceId: string) {
  const person = await requirePersonSession();
  try { await revokeAcceptance(acceptanceId, person.personId); }
  catch (err) { if (isDomain(err)) redirect(detail(interviewId, { error: (err as Error).message })); throw err; }
  redirect(detail(interviewId, { saved: "rescind" }));
}

export async function submitEvaluationAction(interviewId: string, formData: FormData) {
  const person = await requirePersonSession();
  const score = Number(formData.get("score"));
  const comments = String(formData.get("comments") ?? "").trim() || null;
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    redirect(detail(interviewId, { error: "Score must be 1 to 5." }));
  }
  try { await submitEvaluation(interviewId, person.personId, score, comments); }
  catch (err) { if (isDomain(err)) redirect(detail(interviewId, { error: (err as Error).message })); throw err; }
  redirect(detail(interviewId, { saved: "evaluation" }));
}
