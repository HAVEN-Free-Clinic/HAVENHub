import type { Track } from "@prisma/client";
import type { ContractLayout } from "../layout";
import { VOLUNTEER_LAYOUT } from "./volunteer";
import { DIRECTOR_LAYOUT } from "./director";

export function defaultContractLayout(track: Track): ContractLayout {
  return track === "DIRECTOR" ? DIRECTOR_LAYOUT : VOLUNTEER_LAYOUT;
}

/** Fallback layout for callers with no track to hand, used when a stored
 *  snapshot is missing or fails to parse. Consumed by `/onboard/[token]/page.tsx`,
 *  `admin/contract/page.tsx`, `recruitment/cycles/[id]/onboarding/[contractId]/page.tsx`,
 *  and `services/onboarding.ts`. */
export const DEFAULT_CONTRACT_LAYOUT = VOLUNTEER_LAYOUT;
