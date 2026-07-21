import type { Track } from "@prisma/client";
import type { ContractLayout } from "../layout";
import { VOLUNTEER_LAYOUT } from "./volunteer";
import { DIRECTOR_LAYOUT } from "./director";

export function defaultContractLayout(track: Track): ContractLayout {
  return track === "DIRECTOR" ? DIRECTOR_LAYOUT : VOLUNTEER_LAYOUT;
}

/** Retained for the render fallback in `/onboard/[token]/page.tsx`, which has no
 *  track to hand when a snapshot fails to parse. */
export const DEFAULT_CONTRACT_LAYOUT = VOLUNTEER_LAYOUT;
