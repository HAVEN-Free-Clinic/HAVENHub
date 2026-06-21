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