import { cache } from "react";
import { getSetting } from "@/platform/settings/service";
import { normalizeZone, type DisplayTimeZone } from "./zone";

/**
 * The app-wide display time zone, resolved from the display.timeZone setting.
 * Memoised per request via React cache, so many components resolve it once.
 */
export const getDisplayTimeZone = cache(async (): Promise<DisplayTimeZone> => {
  return normalizeZone(await getSetting<string>("display.timeZone"));
});
