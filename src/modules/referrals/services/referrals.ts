import { prisma } from "@/platform/db";
import type { ProviderCategory } from "@prisma/client";

export async function listReferralSites(filters?: {
  category?: ProviderCategory;
  acceptsUninsured?: boolean;
  freeCareEligible?: boolean;
  spanishSpeaking?: boolean;
}) {
  return prisma.referralSite.findMany({
    where: {
      category: filters?.category,
      acceptsUninsured: filters?.acceptsUninsured ? true : undefined,
      freeCareEligible: filters?.freeCareEligible ? true : undefined,
      languages: filters?.spanishSpeaking
        ? { hasSome: ["Spanish", "Spanish "] }
        : undefined,
    },
    include: { providers: true },
    orderBy: { name: "asc" },
  });
}

export async function getReferralSite(id: string) {
  return prisma.referralSite.findUniqueOrThrow({
    where: { id },
    include: { providers: true },
  });
}

export async function createReferralSite(input: {
  name: string;
  category: ProviderCategory;
  specialty: string;
  system: "YNHH" | "COMMUNITY_HC" | "COMMUNITY_NONPROFIT" | "STATE_RESOURCE_HUB" | "NONPROFIT_LEGAL_AID";
  acceptsUninsured?: boolean;
  freeCareEligible?: boolean;
  slidingScale?: boolean;
  waitWeeks?: number;
  waitNote?: string;
  phone: string;
  address: string;
  languages?: string[];
  schedulingContact: string;
  fax?: string;
  referralSteps?: string[];
  notes?: string;
  flag?: "SUCCESS" | "WARN" | "INFO";
  flagText?: string;
}) {
  return prisma.referralSite.create({
    data: {
      ...input,
      languages: input.languages ?? [],
      referralSteps: input.referralSteps ?? [],
      lastReviewedAt: new Date(),
    },
  });
}

export async function updateReferralSite(
  id: string,
  input: Partial<{
    name: string;
    category: ProviderCategory;
    specialty: string;
    acceptsUninsured: boolean;
    freeCareEligible: boolean;
    slidingScale: boolean;
    waitWeeks: number;
    waitNote: string;
    phone: string;
    address: string;
    languages: string[];
    schedulingContact: string;
    fax: string;
    referralSteps: string[];
    notes: string;
    flag: "SUCCESS" | "WARN" | "INFO";
    flagText: string;
  }>
) {
  return prisma.referralSite.update({
    where: { id },
    data: { ...input, lastReviewedAt: new Date() },
  });
}