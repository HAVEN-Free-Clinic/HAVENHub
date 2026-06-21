import { prisma } from "@/platform/db";
import type { ReferralType, ReferralPurpose, ReferralUrgency } from "@prisma/client";

export async function createReferral(input: {
  patientId: string;
  referralType: ReferralType;
  purpose: ReferralPurpose;
  urgency?: ReferralUrgency;
  referringDepartmentId?: string;
  specialty?: string;
  reasonForReferral?: string;
}) {
  return prisma.referral.create({
    data: {
      patientId: input.patientId,
      referralType: input.referralType,
      purpose: input.purpose,
      urgency: input.urgency ?? "ROUTINE",
      referringDepartmentId: input.referringDepartmentId,
      specialty: input.specialty,
      reasonForReferral: input.reasonForReferral,
      transitions: {
        create: {
          fromState: null,
          toState: "ENTERED",
          reason: "Referral created",
        },
      },
    },
  });
}




export async function recordFCEvent(input: {
  patientId: string;
  status: "APPROVED" | "DENIED" | "DISCOUNTED_CARE" | "STILL_PENDING";
  effectiveAt: Date;
  source: string;
  enteredById?: string;
  notes?: string;
}) {
  return prisma.$transaction(async (tx) => {
    const event = await tx.fCEvent.create({
      data: {
        patientId: input.patientId,
        status: input.status,
        effectiveAt: input.effectiveAt,
        source: input.source,
        enteredById: input.enteredById,
        notes: input.notes,
      },
    });

    await tx.patient.update({
      where: { id: input.patientId },
      data: { fcStatus: input.status },
    });

    return event;
  });
}





import type { ReferralState } from "@prisma/client";

export async function transitionReferralState(input: {
  referralId: string;
  toState: ReferralState;
  reason?: string;
  changedById?: string;
}) {
  return prisma.$transaction(async (tx) => {
    const referral = await tx.referral.findUniqueOrThrow({
      where: { id: input.referralId },
      include: { patient: true },
    });

    if (input.toState === "SCHEDULED") {
      const fcOk =
        referral.patient.fcStatus === "APPROVED" ||
        referral.patient.fcStatus === "DISCOUNTED_CARE";
      const urgentOverride = referral.urgency !== "ROUTINE";

      if (!fcOk && !urgentOverride) {
        throw new Error(
          "Cannot schedule: free care is not approved and referral is not urgent"
        );
      }
    }

    const updated = await tx.referral.update({
      where: { id: input.referralId, version: referral.version },
      data: {
        state: input.toState,
        version: { increment: 1 },
      },
    });

    await tx.referralTransition.create({
      data: {
        referralId: input.referralId,
        fromState: referral.state,
        toState: input.toState,
        reason: input.reason,
        changedById: input.changedById,
      },
    });

    return updated;
  });
}