"use client";

import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_TIME_ZONE } from "./zone";

const Ctx = createContext<string>(DEFAULT_TIME_ZONE);

/** Supplies the server-resolved display zone to client components. */
export function TimeZoneProvider({ zone, children }: { zone: string; children: ReactNode }) {
  return <Ctx.Provider value={zone}>{children}</Ctx.Provider>;
}

/** The configured display zone (IANA id). Defaults to Eastern outside a provider. */
export function useTimeZone(): string {
  return useContext(Ctx);
}
