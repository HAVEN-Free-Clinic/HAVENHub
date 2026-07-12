import { cache } from "react";

/** Curated set of US display zones offered in the admin picker. */
export const US_TIME_ZONES = [
  { value: "America/New_York", label: "Eastern (New York)" },
  { value: "America/Chicago", label: "Central (Chicago)" },
  { value: "America/Denver", label: "Mountain (Denver)" },
  { value: "America/Phoenix", label: "Mountain, no daylight saving (Phoenix)" },
  { value: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { value: "America/Anchorage", label: "Alaska (Anchorage)" },
  { value: "Pacific/Honolulu", label: "Hawaii (Honolulu)" },
] as const;

export const US_TIME_ZONE_IDS = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
] as const;

export type DisplayTimeZone = (typeof US_TIME_ZONE_IDS)[number];

export const DEFAULT_TIME_ZONE: DisplayTimeZone = "America/New_York";

/** Coerce a stored/raw zone string to a known display zone, else the default. */
export function normalizeZone(raw: string | null | undefined): DisplayTimeZone {
  return (US_TIME_ZONE_IDS as readonly string[]).includes(raw ?? "")
    ? (raw as DisplayTimeZone)
    : DEFAULT_TIME_ZONE;
}

/**
 * The app-wide display time zone, resolved from the `display.timeZone` setting.
 * Memoised per request via React cache, so many components resolve it once.
 *
 * The settings service is imported lazily (rather than statically at the top of
 * this file) to avoid a module-load cycle: the settings registry imports
 * US_TIME_ZONES/US_TIME_ZONE_IDS from this file to build the setting's select
 * options, and the settings service imports the registry.
 */
export const getDisplayTimeZone = cache(async (): Promise<DisplayTimeZone> => {
  const { getSetting } = await import("@/platform/settings/service");
  return normalizeZone(await getSetting<string>("display.timeZone"));
});
