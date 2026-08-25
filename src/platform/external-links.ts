/**
 * External institution URLs. Hardcoded like the app's other Yale/YNHH
 * assumptions (SSO, Epic requests). Promote to configurable settings only if a
 * second deployment ever needs different values.
 */

/** Yale Workday Learning: where volunteers complete EHS and HIPAA training. */
export const WORKDAY_LEARNING_URL = "https://www.myworkday.com/yale/learning";

/**
 * Yale Campus Health "HealthOnTrack": where the health requirements behind EHS
 * clearance are completed. The TB baseline screening and the HepB immunity
 * assessment live here, NOT in Workday, which is the single most common reason
 * an EHS item stalls.
 */
export const HEALTH_ON_TRACK_URL =
  "https://healthontrack.yale.edu/s/chs-health-requirement/CHS_Health_Requirement__c/";

/** YNHH remote apps portal: where provisioned users launch Epic. */
export const EPIC_APPS_URL = "https://myapps.ynhh.org";
