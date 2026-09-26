import Constants from "expo-constants";

/**
 * The Hub this build talks to. Production by default (app.json `extra.hubUrl`);
 * set EXPO_PUBLIC_HUB_URL to point a dev build at staging or a local `next dev`
 * (see README.md).
 */
export const HUB_URL: string = (
  process.env.EXPO_PUBLIC_HUB_URL ??
  (Constants.expoConfig?.extra?.hubUrl as string | undefined) ??
  "https://hub.havenfreeclinic.org"
).replace(/\/+$/, "");

/** The OAuth resource the app's tokens are bound to; must match MOBILE_RESOURCE on the server. */
export const MOBILE_RESOURCE = `${HUB_URL}/api/mobile`;
export const MOBILE_SCOPE = "mobile";

export const AUTHORIZE_URL = `${HUB_URL}/oauth/authorize`;
export const TOKEN_URL = `${HUB_URL}/api/oauth/token`;
export const REGISTER_URL = `${HUB_URL}/api/oauth/register`;
export const API_BASE = `${HUB_URL}/api/mobile/v1`;
