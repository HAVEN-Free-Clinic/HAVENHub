import { z } from "zod";
import { config, type AppConfig } from "@/platform/config";
import { brandingAssetSchema, type BrandingAsset } from "@/platform/branding/asset-types";
import { NOTIFICATION_TYPES, channelSettingKey, type NotificationChannel } from "@/platform/notifications/registry";

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
    help: "Largest allowed file upload, in megabytes. Airtable caps attachments at 5 MB.",
    input: { type: "number", min: 1 },
    schema: z.number().int().positive(),
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
    key: "compliance.escalationThreshold",
    category: "Operations",
    label: "Compliance escalation threshold",
    help: "Number of reminders sent before escalating to the director.",
    input: { type: "number", min: 1 },
    schema: z.number().int().positive(),
    envDefault: () => config.COMPLIANCE_ESCALATION_THRESHOLD,
    secret: false,
  }),
  define<string>({
    key: "email.sender",
    category: "Email",
    label: "Email sender address",
    help: "From-address used when sending via Microsoft Graph. Required before enabling graph email.",
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
  define<"log" | "graph">({
    key: "email.transport",
    category: "Email",
    label: "Email transport",
    help: "How outbound email is sent. 'log' prints to the server log; 'graph' sends via Microsoft Graph (requires OAuth credentials in the environment). Cron-based delivery applies a change immediately; restart the worker process for queue-based delivery.",
    input: { type: "select", options: [
      { value: "log", label: "Log (no real email)" },
      { value: "graph", label: "Microsoft Graph (live email)" },
    ] },
    schema: z.enum(["log", "graph"]),
    envDefault: () => config.EMAIL_TRANSPORT,
    secret: false,
    validate: async (value, { config, getSetting }) => {
      if (value !== "graph") return null;
      const problems: string[] = (
        ["GRAPH_OAUTH_TENANT_ID", "GRAPH_OAUTH_CLIENT_ID", "GRAPH_OAUTH_CLIENT_SECRET"] as const
      ).filter((k) => !config[k]);
      const sender = await getSetting<string>("email.sender");
      if (!sender) problems.push("a sender address (set Email > Sender first)");
      return problems.length
        ? `Cannot enable graph email until these are configured: ${problems.join(", ")}.`
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
];

const BY_KEY = new Map(SETTINGS.map((d) => [d.key, d]));

/** Look up a definition. Throws for an unregistered key (programmer error). */
export function getSettingDef(key: string): SettingDef<unknown> {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`Unregistered setting key: ${key}`);
  return def;
}

/** Distinct categories, in first-seen order, for rendering form groups. */
export function listCategories(): string[] {
  return [...new Set(SETTINGS.map((d) => d.category))];
}
