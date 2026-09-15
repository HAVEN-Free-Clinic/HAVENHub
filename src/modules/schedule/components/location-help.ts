/**
 * How to unblock location on the device in hand.
 *
 * Once a browser has been told "Don't Allow" it stops asking, and every later
 * tap fails at once with PERMISSION_DENIED. The old copy said "turn on location
 * for this site", which does not say where: the switch is somewhere different
 * on each platform, and on iOS it can be the phone-wide Location Services
 * switch rather than anything about this site. In production one volunteer
 * tapped Check in 49 times in two minutes.
 *
 * Pure, so the detection and the copy are unit tested.
 */

export type LocationPlatform = "ios-safari" | "ios-chrome" | "ios-other" | "android" | "desktop";

export function detectLocationPlatform(userAgent: string, maxTouchPoints: number): LocationPlatform {
  // iPadOS Safari asks for the desktop site by default and sends a Mac user
  // agent, so a "Mac" with a touch screen is an iPad.
  const ios = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  if (ios) {
    if (/CriOS/.test(userAgent)) return "ios-chrome";
    if (/FxiOS|EdgiOS|OPiOS/.test(userAgent)) return "ios-other";
    return "ios-safari";
  }
  if (/Android/.test(userAgent)) return "android";
  return "desktop";
}

const LOCATION_SERVICES = "Open Settings > Privacy & Security > Location Services and make sure it is on.";
const RELOAD = "Then reload this page and tap Check in again.";

const STEPS: Record<LocationPlatform, string[]> = {
  "ios-safari": [
    LOCATION_SERVICES,
    "On that same screen, tap Safari Websites and choose While Using the App.",
    "Back in Safari, open the page menu beside the address, tap Website Settings, and set Location to Allow.",
    RELOAD,
  ],
  "ios-chrome": [LOCATION_SERVICES, "Open Settings > Chrome > Location and choose While Using the App.", RELOAD],
  "ios-other": [
    LOCATION_SERVICES,
    "In Settings, find this browser's app, open Location, and choose While Using the App.",
    RELOAD,
  ],
  android: [
    "Swipe down from the top of the screen and make sure Location is on.",
    "In Chrome, tap the icon to the left of the address, then Permissions, and set Location to Allow.",
    RELOAD,
  ],
  desktop: [
    "Click the icon to the left of the address bar and allow Location for this site.",
    "On a Mac, also check that System Settings > Privacy & Security > Location Services allows your browser.",
    RELOAD,
  ],
};

export function locationUnblockSteps(platform: LocationPlatform): string[] {
  return STEPS[platform];
}
