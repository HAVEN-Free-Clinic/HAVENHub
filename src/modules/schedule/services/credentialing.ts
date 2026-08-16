/**
 * Attending credentialing: the onboarding pipeline Faculty Relations runs before
 * a new attending can work a clinic.
 *
 * The stages are independent booleans rather than one status enum because that
 * is how the work actually goes: forms, NPDB, OAPD and FTCA are chased in
 * parallel and complete out of order, and a single status could not express
 * "forms in, NPDB clear, still waiting on the steering committee".
 *
 * Two approval routes exist and are mutually exclusive in practice: a
 * Yale-affiliated attending goes to the medical directors, a community provider
 * goes to the steering committee. Both are modelled because which one applies is
 * a judgement Faculty Relations makes per person.
 */

import type { AttendingCredentialing } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { canManageAttendings, AttendingForbiddenError, AttendingValidationError } from "./attendings";

/** The documented process, shown alongside the tracker so it is not just checkboxes. */
export const CREDENTIALING_STEPS: Array<{ title: string; detail: string }> = [
  {
    title: "Send the info email",
    detail: "Email the interested attending what HAVEN is and what the commitment involves.",
  },
  {
    title: "Collect the credentialing form",
    detail:
      "Once the form is back, ask whether they need FTCA coverage. If they do, tell the medical director.",
  },
  {
    title: "OAPD and NPDB checks",
    detail:
      "Email faculty.affairs@yale.edu (OAPD) to confirm the attending is clear, and send the credentialing form on for the NPDB check.",
  },
  {
    title: "Yale-affiliated: medical director approval",
    detail:
      "For a YMS or YNHH attending, email the medical directors to confirm the application. Batch these and send by the 15th of the month.",
  },
  {
    title: "Community provider: steering committee approval",
    detail:
      "For an attending from outside Yale, send their materials on to be presented at the steering committee meeting.",
  },
  {
    title: "Hand off to the clinical advisors",
    detail:
      "Once everything above is done, CC the clinical advisors so they can follow up with the attending about next steps.",
  },
];

/**
 * Volunteers are NOT put through this.
 *
 * Recorded here because the distinction is easy to lose and the consequence is
 * a volunteer stuck behind an approval process built for faculty.
 */
export const VOLUNTEER_NOTE =
  "Volunteers do not go through this process. A volunteer needs the credentialing form and an NPDB check only; CC the department they want to work with and they will send anything else.";

export type CredentialingRow = {
  attendingId: string;
  scheduleName: string;
  fullName: string;
  specialtyName: string | null;
  isActive: boolean;
  credentialing: AttendingCredentialing | null;
};

/**
 * Everyone on the roster with their pipeline state.
 *
 * The whole roster, not only those mid-pipeline: an attending with no
 * credentialing row has simply not been started, and hiding them would make the
 * tracker useless for deciding who to start next.
 */
export async function listCredentialing(): Promise<CredentialingRow[]> {
  const rows = await prisma.attending.findMany({
    include: { credentialing: true, specialty: { select: { name: true } } },
    orderBy: [{ isActive: "desc" }, { scheduleName: "asc" }],
  });

  return rows.map((a) => ({
    attendingId: a.id,
    scheduleName: a.scheduleName,
    fullName: a.fullName,
    specialtyName: a.specialty?.name ?? null,
    isActive: a.isActive,
    credentialing: a.credentialing,
  }));
}

/** The stages, as the form posts them. */
export type CredentialingPatch = {
  infoEmailSent?: boolean;
  formsReceived?: boolean;
  npdbCheck?: boolean;
  oapd?: boolean;
  needsFtca?: boolean;
  ftcaSubmitted?: boolean;
  medDirectorApprovalNeeded?: boolean;
  medDirectorApproved?: boolean;
  steeringCommitteeApprovalNeeded?: boolean;
  steeringCommitteeApproved?: boolean;
  approved?: boolean;
  notes?: string | null;
};

/**
 * Record where an attending has got to.
 *
 * Upserts, so the first save on an attending who has never been tracked creates
 * the row rather than erroring. Requires schedule.manage_attendings: this is
 * Faculty Relations' process and it holds credentialing judgements.
 */
export async function updateCredentialing(
  actor: string,
  attendingId: string,
  patch: CredentialingPatch,
): Promise<AttendingCredentialing> {
  if (!(await canManageAttendings(actor))) throw new AttendingForbiddenError();

  const attending = await prisma.attending.findUnique({
    where: { id: attendingId },
    select: { id: true },
  });
  if (!attending) throw new AttendingValidationError("Attending not found.");

  const before = await prisma.attendingCredentialing.findUnique({ where: { attendingId } });

  const data = {
    ...(patch.infoEmailSent !== undefined && { infoEmailSent: patch.infoEmailSent }),
    ...(patch.formsReceived !== undefined && { formsReceived: patch.formsReceived }),
    ...(patch.npdbCheck !== undefined && { npdbCheck: patch.npdbCheck }),
    ...(patch.oapd !== undefined && { oapd: patch.oapd }),
    ...(patch.needsFtca !== undefined && { needsFtca: patch.needsFtca }),
    ...(patch.ftcaSubmitted !== undefined && { ftcaSubmitted: patch.ftcaSubmitted }),
    ...(patch.medDirectorApprovalNeeded !== undefined && {
      medDirectorApprovalNeeded: patch.medDirectorApprovalNeeded,
    }),
    ...(patch.medDirectorApproved !== undefined && { medDirectorApproved: patch.medDirectorApproved }),
    ...(patch.steeringCommitteeApprovalNeeded !== undefined && {
      steeringCommitteeApprovalNeeded: patch.steeringCommitteeApprovalNeeded,
    }),
    ...(patch.steeringCommitteeApproved !== undefined && {
      steeringCommitteeApproved: patch.steeringCommitteeApproved,
    }),
    ...(patch.approved !== undefined && { approved: patch.approved }),
    ...("notes" in patch && { notes: patch.notes?.trim() || null }),
  };

  const updated = await prisma.attendingCredentialing.upsert({
    where: { attendingId },
    create: { attendingId, ...data },
    update: data,
  });

  await recordAudit({
    actorPersonId: actor,
    action: "schedule.attending_credentialing",
    entityType: "AttendingCredentialing",
    entityId: attendingId,
    ...(before && { before: auditShape(before) }),
    after: auditShape(updated),
  });

  return updated;
}

function auditShape(r: AttendingCredentialing) {
  return {
    infoEmailSent: r.infoEmailSent,
    formsReceived: r.formsReceived,
    npdbCheck: r.npdbCheck,
    oapd: r.oapd,
    needsFtca: r.needsFtca,
    ftcaSubmitted: r.ftcaSubmitted,
    medDirectorApprovalNeeded: r.medDirectorApprovalNeeded,
    medDirectorApproved: r.medDirectorApproved,
    steeringCommitteeApprovalNeeded: r.steeringCommitteeApprovalNeeded,
    steeringCommitteeApproved: r.steeringCommitteeApproved,
    approved: r.approved,
    notes: r.notes,
  };
}

/**
 * What is left before this attending is cleared, in plain words.
 *
 * Derived rather than stored: the outstanding list changes as soon as a stage is
 * ticked, and a stored summary would be one save behind. Returns [] for someone
 * already approved, and for someone not yet started (there is nothing
 * "outstanding" until Faculty Relations picks them up).
 */
export function outstandingSteps(row: AttendingCredentialing | null): string[] {
  if (!row || row.approved) return [];
  const out: string[] = [];
  if (!row.infoEmailSent) out.push("info email");
  if (!row.formsReceived) out.push("credentialing form");
  if (!row.npdbCheck) out.push("NPDB check");
  if (!row.oapd) out.push("OAPD");
  // Only chased when the attending actually needs the coverage.
  if (row.needsFtca && !row.ftcaSubmitted) out.push("FTCA");
  if (row.medDirectorApprovalNeeded && !row.medDirectorApproved) out.push("medical director");
  if (row.steeringCommitteeApprovalNeeded && !row.steeringCommitteeApproved) {
    out.push("steering committee");
  }
  return out;
}
