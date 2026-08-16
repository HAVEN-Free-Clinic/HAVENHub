import { z } from "zod";
import { config, type AppConfig } from "@/platform/config";
import { brandingAssetSchema, type BrandingAsset } from "@/platform/branding/asset-types";
import { NOTIFICATION_TYPES, channelSettingKey, type NotificationChannel } from "@/platform/notifications/registry";
import { US_TIME_ZONES, US_TIME_ZONE_IDS } from "@/platform/dates/zone";

export interface SettingValidateCtx {
  /** Env config, for checking that required secrets are present. */
  config: AppConfig;
  /** Resolve a sibling setting (DB override -> env default). */
  getSetting: <U>(key: string) => Promise<U>;
}

export type SettingInput =
  | { type: "number"; min?: number; max?: number }
  | { type: "text" }
  | { type: "textarea" }
  | { type: "boolean" }
  | { type: "color" }
  | { type: "image" }
  | { type: "select"; options: { value: string; label: string }[] };

export interface SettingDef<T> {
  /** Dotted, stable identifier, e.g. "rhd.maxProcedures". */
  key: string;
  /** Group heading in the admin UI. */
  category: string;
  /** Form field label. */
  label: string;
  /** Help text shown under the field. */
  help: string;
  /** Render hint for the auto-generated form. */
  input: SettingInput;
  /**
   * When true, excluded from the auto-rendered /admin/settings form (and its
   * category list) but still fully readable/writable via getSetting/setSetting
   * by key. Use for settings edited through their own dedicated UI.
   */
  hidden?: boolean;
  /** Validates both stored DB values and submitted form input. */
  schema: z.ZodType<T>;
  /** Seed value, sourced from env via `config`. */
  envDefault: () => T;
  /** Always false -- secrets are never registered. */
  secret: false;
  /**
   * Optional cross-field guard, run on WRITE only (after schema parse). Return
   * an error message to reject the change, or null to allow it. Omit for simple
   * settings.
   */
  validate?: (value: T, ctx: SettingValidateCtx) => Promise<string | null>;
}

/**
 * Authoring helper: preserves per-entry type checking (the object must satisfy
 * SettingDef<T>) while letting the SETTINGS array be uniformly typed.
 */
function define<T>(def: SettingDef<T>): SettingDef<unknown> {
  return def as unknown as SettingDef<unknown>;
}

/** 24-hour HH:MM, 00:00 through 23:59. */
const TIME_OF_DAY = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM, for example 08:00");

/**
 * Every admin-editable setting, declared exactly once. Adding a setting here is
 * all that is required for it to appear (auto-rendered) in /admin/settings.
 * Phase 0 registers only the canary; Phases 1-3 add the rest.
 */
export const SETTINGS: SettingDef<unknown>[] = [
  define<number>({
    key: "rhd.maxProcedures",
    category: "Operations",
    label: "Max procedures per RHD session",
    help: "Caps the number of procedures bookable in one RHD clinic session.",
    input: { type: "number", min: 1 },
    schema: z.number().int().positive(),
    envDefault: () => config.RHD_MAX_PROCEDURES,
    secret: false,
  }),
  define<number>({
    key: "uploads.maxMb",
    category: "Operations",
    label: "Max upload size (MB)",
    // Capped at 4: every upload path except SCORM packages goes through a Server
    // Action, which the platform hard-limits to ~4.5 MB (FUNCTION_PAYLOAD_TOO_LARGE)
    // regardless of the app's own limit. A larger value is accepted here but every
    // upload over the platform cap still fails opaquely at the edge, before any app
    // code runs -- so the setting must never promise more than the platform allows (#75).
    help: "Largest allowed file upload, in megabytes (max 4 -- the platform request-body cap for uploads). Applies to all file uploads across the app.",
    input: { type: "number", min: 1, max: 4 },
    schema: z.number().int().min(1).max(4),
    envDefault: () => config.MAX_UPLOAD_MB,
    secret: false,
  }),
  define<number>({
    key: "compliance.reminderIntervalDays",
    category: "Operations",
    label: "Compliance reminder interval (days)",
    help: "Days between compliance reminder emails.",
    input: { type: "number", min: 1 },
    schema: z.number().int().positive(),
    envDefault: () => config.COMPLIANCE_REMINDER_INTERVAL_DAYS,
    secret: false,
  }),
  define<number>({
    key: "onboarding.reminderIntervalDays",
    category: "Operations",
    label: "Onboarding reminder interval (days)",
    help: "Days between onboarding-requirement reminder emails. Separate from the HIPAA reminder interval, and much shorter by default.",
    input: { type: "number", min: 1 },
    schema: z.number().int().positive(),
    envDefault: () => config.ONBOARDING_REMINDER_INTERVAL_DAYS,
    secret: false,
  }),
  define<number>({
    key: "clinic.checkInLatitude",
    category: "Operations",
    label: "Clinic check-in latitude",
    help: "Latitude of the clinic check-in geofence centre. Confirm this against the actual entrance: a centre even fifty metres off will fail volunteers standing at the door.",
    input: { type: "number" },
    schema: z.number().min(-90).max(90),
    envDefault: () => config.CLINIC_CHECKIN_LATITUDE,
    secret: false,
  }),
  define<number>({
    key: "clinic.checkInLongitude",
    category: "Operations",
    label: "Clinic check-in longitude",
    help: "Longitude of the clinic check-in geofence centre.",
    input: { type: "number" },
    schema: z.number().min(-180).max(180),
    envDefault: () => config.CLINIC_CHECKIN_LONGITUDE,
    secret: false,
  }),
  define<number>({
    key: "clinic.checkInRadiusMeters",
    category: "Operations",
    label: "Clinic check-in radius (metres)",
    help: "How near the clinic a volunteer must be to check themselves in. Location accuracy indoors is poor, so this is a deterrent rather than proof of presence; a director can always check someone in manually.",
    input: { type: "number", min: 10 },
    schema: z.number().int().min(10),
    envDefault: () => config.CLINIC_CHECKIN_RADIUS_METERS,
    secret: false,
  }),
  define<number>({
    key: "clinic.checkInMaxAccuracyMeters",
    category: "Operations",
    label: "Clinic check-in accuracy limit (metres)",
    help: "Location fixes less precise than this are rejected as unusable rather than guessed at, and the volunteer is asked to see a director. Raise it if too many on-site volunteers are being turned away.",
    input: { type: "number", min: 10 },
    schema: z.number().int().min(10),
    envDefault: () => config.CLINIC_CHECKIN_MAX_ACCURACY_METERS,
    secret: false,
  }),
  define<string>({
    key: "email.sender",
    category: "Email",
    label: "Email sender address",
    // One setting, two incompatible meanings, and the help text used to name only
    // the first (audit 14, EMAIL-3). Under Graph this must be a Yale mailbox the
    // connected account has Send-As on; under Maileroo it must be on the verified
    // Maileroo domain, because MailerooTransport PINS it and ignores every
    // per-message `from`. Switching transport without changing this address makes
    // every send fail permanently as a 4xx, and nothing told the admin to look.
    help:
      "From-address for outbound email. Under Microsoft Graph this must be a mailbox the connected account can Send-As. Under Maileroo it must be on your verified Maileroo domain, and it overrides every per-template sender. Change it when you switch transport, then run a sender test.",
    input: { type: "text" },
    schema: z.string(),
    envDefault: () => config.EMAIL_SENDER ?? "",
    secret: false,
  }),
  define<string>({
    key: "app.baseUrl",
    category: "Email",
    label: "App base URL",
    help: "Public base URL used in links inside outbound email (e.g. onboarding contract links).",
    input: { type: "text" },
    schema: z.string().url(),
    envDefault: () => config.APP_BASE_URL,
    secret: false,
  }),
  define<boolean>({
    key: "auth.memberMagicLinkEnabled",
    category: "Operations",
    label: "Member email sign-in links",
    help: "Allow active members whose contact email is not a Yale address to sign in with a one-time link emailed to them. Yale members always use Sign in with Yale.",
    input: { type: "boolean" },
    schema: z.boolean(),
    envDefault: () => true,
    secret: false,
  }),
  define<boolean>({
    key: "support.blockerGateEnabled",
    category: "Operations",
    label: "Block the app when the support assistant will not load",
    help: "When on, a member whose browser cannot load the support assistant is stopped by a message asking them to turn their content blocker off. TURN THIS OFF if support breaks for everyone at once: from the browser, an Intercom or network outage is indistinguishable from a content blocker, so an outage would otherwise lock every member out of the hub. Turning it off stops the app blocking anyone and leaves the support assistant itself running. No deploy needed: it applies on each member's next page load, within 30 seconds, so anyone already stuck behind the message is freed by reloading. Leave it on when support is broken only for individuals, which is what a real content blocker looks like.",
    input: { type: "boolean" },
    schema: z.boolean(),
    envDefault: () => true,
    secret: false,
  }),
  define<number>({
    key: "incidents.strikeThreshold",
    category: "Operations",
    label: "Disciplinary strike limit",
    help: "How many strikes constitute reaching the limit under clinic policy. Reaching it is flagged on the strikes ledger and in the notification to a member's directors. It deliberately triggers nothing automatic: whether a member is offboarded stays a decision the Executive Directors make.",
    input: { type: "number", min: 1 },
    schema: z.number().int().min(1),
    envDefault: () => 3,
    secret: false,
  }),
  define<string>({
    key: "epic.temporaryPassword",
    category: "Integrations",
    label: "Epic temporary password",
    help: "The temporary password YNHH sets on a new Epic account, quoted in the activation email's setup steps. YNHH rotates this periodically; update it here the moment they do, or every new volunteer is told a password that no longer works. Leave blank to omit the password from the instructions entirely.",
    input: { type: "text" },
    // Deliberately NOT treated as a secret. It is a shared institutional default
    // that YNHH issues and that this system emails, in plaintext, to every new
    // Epic user by design. It is not a credential this application holds, and an
    // admin needs to READ it to check it against what YNHH currently sets, which
    // masking would prevent. (SettingDef.secret is always false regardless:
    // genuine secrets live in env, never in the settings table.)
    schema: z.string(),
    // Seeded with the value that was hardcoded in the activation template up to
    // 2026-08-12, so moving it here changes no outbound email on deploy. The "25"
    // suggests a 2025 rotation and it may already be stale: it needs confirming
    // against what YNHH currently sets. That is exactly the check this setting
    // exists to make possible without a deploy.
    envDefault: () => "SecureCare4u#25",
    secret: false,
  }),
  define<string>({
    key: "teams.clinicGroupId",
    category: "Integrations",
    label: "Teams clinic group ID",
    help: "Microsoft Teams group ID for the clinic. When empty, the home dashboard channel-link card is hidden.",
    input: { type: "text" },
    schema: z.string(),
    envDefault: () => config.TEAMS_CLINIC_GROUP_ID ?? "",
    secret: false,
  }),
  define<"log" | "graph" | "maileroo">({
    key: "email.transport",
    category: "Email",
    label: "Email transport",
    help: "How outbound email is sent. 'log' prints to the server log; 'graph' sends via Microsoft Graph as the Yale shared mailbox (requires OAuth credentials in the environment); 'maileroo' sends via the Maileroo API from our own verified domain (requires MAILEROO_API_KEY). Graph inherits Exchange Online's ~30 messages/minute cap, so a roster-wide campaign paces out over hours; Maileroo has no comparable per-minute ceiling but delivers as external mail to yale.edu inboxes. Teams notifications always use Graph regardless of this setting.",
    input: { type: "select", options: [
      { value: "log", label: "Log (no real email)" },
      { value: "graph", label: "Microsoft Graph (live email)" },
      { value: "maileroo", label: "Maileroo (live email)" },
    ] },
    schema: z.enum(["log", "graph", "maileroo"]),
    envDefault: () => config.EMAIL_TRANSPORT,
    secret: false,
    validate: async (value, { config, getSetting }) => {
      if (value === "log") return null;
      const problems: string[] = [];
      if (value === "graph") {
        problems.push(
          ...(
            ["GRAPH_OAUTH_TENANT_ID", "GRAPH_OAUTH_CLIENT_ID", "GRAPH_OAUTH_CLIENT_SECRET"] as const
          ).filter((k) => !config[k]),
        );
      } else if (!config.MAILEROO_API_KEY) {
        problems.push("MAILEROO_API_KEY");
      }
      const sender = await getSetting<string>("email.sender");
      if (!sender) problems.push("a sender address (set Email > Sender first)");
      return problems.length
        ? `Cannot enable ${value} email until these are configured: ${problems.join(", ")}.`
        : null;
    },
  }),
  define<string>({
    key: "branding.appName",
    category: "Branding",
    label: "Application name",
    help: "The product/platform name, shown in the browser tab, on the sign-in screen, and in admin copy. Distinct from the organization name below.",
    input: { type: "text" },
    schema: z.string().min(1),
    envDefault: () => "HAVEN Hub",
    secret: false,
  }),
  define<string>({
    key: "branding.applyPortalTitle",
    category: "Branding",
    label: "Application portal title",
    help: "The browser-tab title for the public application portal (the /apply pages and the apply subdomain). Overrides the application name there only; the rest of the hub keeps the application name above.",
    input: { type: "text" },
    schema: z.string().min(1),
    envDefault: () => "HAVEN Application Portal",
    secret: false,
  }),
  define<string>({
    key: "branding.orgName",
    category: "Branding",
    label: "Organization name",
    help: "The clinic or organization name shown across the app: the footer, sign-in panel, applicant portal, welcome page, and 404 page.",
    input: { type: "text" },
    schema: z.string().min(1),
    envDefault: () => "HAVEN Free Clinic",
    secret: false,
  }),
  define<string>({
    key: "branding.orgTagline",
    category: "Branding",
    label: "Organization tagline",
    help: "Shown after the organization name (e.g. the parent institution). Leave blank to show just the name.",
    input: { type: "text" },
    schema: z.string(),
    envDefault: () => "Yale University",
    secret: false,
  }),
  define<string>({
    key: "branding.supportEmail",
    category: "Branding",
    label: "Support contact email",
    help: "Inbox shown to locked-out, signed-out users (the sign-in, 404, and welcome pages link to it). Distinct from the outbound email sender. Leave blank to hide the support link entirely.",
    input: { type: "text" },
    // A valid address, or blank to drop the support link. refine (not a union)
    // keeps the admin-facing error message a single clean line.
    schema: z.string().refine((v) => v === "" || z.string().email().safeParse(v).success, {
      message: "Must be a valid email address, or blank to hide the support link.",
    }),
    envDefault: () => "hfc.it@yale.edu",
    secret: false,
  }),
  define<string>({
    key: "branding.brandColor",
    category: "Branding",
    label: "Primary brand color",
    help: "Main brand color. Buttons, links, and accents derive from it; shade variants are computed automatically.",
    input: { type: "color" },
    schema: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a 6-digit hex color like #00356b"),
    envDefault: () => "#00356b",
    secret: false,
  }),
  define<BrandingAsset>({
    key: "branding.logo",
    category: "Branding",
    label: "Logo",
    help: "Monochrome or transparent PNG silhouette. It is tinted to the brand color automatically. PNG, JPEG, or WebP.",
    input: { type: "image" },
    schema: brandingAssetSchema,
    envDefault: () => ({ contentType: "", version: 0 }),
    secret: false,
  }),
  define<BrandingAsset>({
    key: "branding.favicon",
    category: "Branding",
    label: "Favicon",
    help: "Small square icon shown in the browser tab. PNG, ICO, or WebP.",
    input: { type: "image" },
    schema: brandingAssetSchema,
    // version bumped to 1 to cache-bust the new bundled default favicon
    // (public/brand/haven-favicon.png) past browsers that cached the old ?v=0 URL.
    envDefault: () => ({ contentType: "", version: 1 }),
    secret: false,
  }),
  define<"light" | "dark" | "system">({
    key: "ui.defaultTheme",
    category: "Branding",
    label: "Default appearance",
    help: "The theme used for users who have not chosen one, and for signed-out pages. Users can override this for themselves.",
    input: { type: "select", options: [
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
      { value: "system", label: "System (follow device)" },
    ] },
    schema: z.enum(["light", "dark", "system"]),
    envDefault: () => "system",
    secret: false,
  }),
  define<unknown>({
    key: "onboarding.contractTemplate",
    category: "Onboarding",
    label: "Onboarding contract (master template)",
    help: "The default onboarding contract every new cycle inherits. Edit per cycle from the cycle's Form builder.",
    input: { type: "textarea" },
    hidden: true,
    schema: z.unknown(),
    envDefault: () => null,
    secret: false,
  }),
  ...NOTIFICATION_TYPES.map((t) =>
    define<NotificationChannel>({
      key: channelSettingKey(t.key),
      category: "Notifications",
      label: t.label,
      help: `Where to deliver the "${t.label}" notification.`,
      input: {
        type: "select",
        options: [
          { value: "email", label: "Email" },
          { value: "teams", label: "Teams DM" },
          { value: "both", label: "Email + Teams DM" },
        ],
      },
      schema: z.enum(["email", "teams", "both"]),
      envDefault: () => t.defaultChannel,
      secret: false,
    })
  ),
  define<string>({
    key: "display.timeZone",
    category: "Operations",
    label: "Display time zone",
    help: "All dates and times across the app are shown in this time zone. Calendar dates (clinic days, term dates) are unaffected.",
    input: { type: "select", options: US_TIME_ZONES.map((tz) => ({ value: tz.value, label: tz.label })) },
    schema: z.enum(US_TIME_ZONE_IDS),
    envDefault: () => config.DISPLAY_TIME_ZONE,
    secret: false,
  }),
  define<string>({
    key: "schedule.clinicStartTime",
    category: "Operations",
    label: "Clinic start time",
    help: "When a clinic day begins, in the display time zone. Shifts are date-only in the Hub, so exported calendar events use this window.",
    input: { type: "text" },
    schema: TIME_OF_DAY,
    envDefault: () => "08:00",
    secret: false,
    validate: async (value, ctx) => {
      const end = await ctx.getSetting<string>("schedule.clinicEndTime");
      return value < end ? null : "Start time must be earlier than the clinic end time.";
    },
  }),
  define<string>({
    key: "schedule.clinicEndTime",
    category: "Operations",
    label: "Clinic end time",
    help: "When a clinic day ends, in the display time zone. Must be later than the start time.",
    input: { type: "text" },
    schema: TIME_OF_DAY,
    envDefault: () => "13:00",
    secret: false,
    validate: async (value, ctx) => {
      const start = await ctx.getSetting<string>("schedule.clinicStartTime");
      return value > start ? null : "End time must be later than the clinic start time.";
    },
  }),
  define<string>({
    key: "schedule.clinicAddress",
    category: "Operations",
    label: "Clinic address",
    help: "Street address of the clinic, used as the location on exported calendar events so members can tap through to directions. Leave blank to omit the location. Shifts marked remote never carry it.",
    input: { type: "text" },
    // Deliberately permissive, including empty: an address is free-form, and a
    // blank value is the documented way to turn the location off.
    schema: z.string(),
    envDefault: () => "800 Howard Ave, New Haven, CT (Yale Physicians Building)",
    secret: false,
  }),
  // Maintenance is registered last so its category renders at the bottom of
  // /admin/settings: it is the one switch on the page that takes the hub away
  // from everybody, and it should not sit next to the settings people edit
  // week to week.
  define<boolean>({
    key: "maintenance.enabled",
    category: "Maintenance",
    label: "Maintenance mode",
    help: "Turns the hub off. Everyone is sent to a maintenance page instead of the site, including signed-in members, and every write stops with them. Only a Platform Admin (the \"*\" grant) keeps using the hub normally, so check who holds it before relying on this. Three things stay up: sign-in, the public volunteer-passport pages, and every /api route, which means cron email delivery, the calendar feed, and health checks all keep running -- this stops people, not background work. It applies within 30 seconds of saving, with no deploy, and turning it back off is the same switch. If you are ever locked out with it on, clear it straight from the database: UPDATE \"Setting\" SET value='false' WHERE key='maintenance.enabled';",
    input: { type: "boolean" },
    schema: z.boolean(),
    envDefault: () => false,
    secret: false,
  }),
  define<string>({
    key: "maintenance.message",
    category: "Maintenance",
    label: "Maintenance message",
    help: "Shown on the maintenance page in place of the default wording. Say what is happening in a sentence, and remember the audience is every volunteer, applicant, and director who tried to open the hub. Leave blank for the default.",
    input: { type: "textarea" },
    schema: z.string().max(500, "Keep the message under 500 characters."),
    envDefault: () => "",
    secret: false,
  }),
  define<string>({
    key: "maintenance.until",
    category: "Maintenance",
    label: "Expected back by",
    help: "Free text, shown under the message as \"Expected back: ...\" -- for example \"9:00 PM Eastern\" or \"Monday morning\". Written out rather than picked from a calendar so it can stay vague; leave it blank to promise nothing, which is better than missing a time you published.",
    input: { type: "text" },
    schema: z.string().max(120, "Keep this under 120 characters."),
    envDefault: () => "",
    secret: false,
  }),
];

const BY_KEY = new Map(SETTINGS.map((d) => [d.key, d]));

/** Look up a definition. Throws for an unregistered key (programmer error). */
export function getSettingDef(key: string): SettingDef<unknown> {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`Unregistered setting key: ${key}`);
  return def;
}

/** Distinct categories, in first-seen order, for rendering form groups. Hidden
 * settings (edited via their own dedicated UI) do not surface a category here. */
export function listCategories(): string[] {
  return [...new Set(SETTINGS.filter((d) => !d.hidden).map((d) => d.category))];
}
