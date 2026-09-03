import { z } from "zod";
// Safe to import back: email/address.ts has NO imports of its own, precisely so
// it can be shared with the browser, so there is no cycle here. The
// SENDING_DOMAINS check below duplicates its regex instead, and has to: it lives
// in email/sending-domains.ts, which reads THIS module.
import { EMAIL_RE } from "@/platform/email/address";

/**
 * The largest upload a Server Action can actually receive, in MB.
 *
 * Vercel rejects a request body over ~4.5 MB with FUNCTION_PAYLOAD_TOO_LARGE
 * before any app code runs, so a limit above this cannot be honored: it only
 * changes the message the user does not get (#75). Every upload path except
 * SCORM packages goes through a Server Action. The uploads.maxMb setting caps
 * its input at the same 4 (src/platform/settings/registry.ts).
 */
const SERVER_ACTION_MAX_UPLOAD_MB = 4;

const schema = z
  .object({
    DATABASE_URL: z.string().min(1),
    AUTH_SECRET: z.string().min(1),
    // Demo/staging escape hatch. When "true", relaxes the production Azure-AD
    // requirement and re-enables the email-only credentials login (see auth.ts)
    // so a deployment without a Yale Entra app is still usable. NEVER set this on
    // a real production deploy holding live volunteer data.
    DEMO_MODE: z
      .string()
      .default("false")
      .transform((v) => v === "true"),
    AZURE_AD_CLIENT_ID: z.string().optional(),
    AZURE_AD_CLIENT_SECRET: z.string().optional(),
    AZURE_AD_TENANT_ID: z.string().optional(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    // Airtable: reads (import) need only the PAT; the listed IDs have safe defaults.
    AIRTABLE_PAT: z.string().optional(),
    HAVEN_MGMT_BASE_ID: z.string().default("appkxTQ19GmaHgW1O"),
    ALL_PEOPLE_TABLE_ID: z.string().default("tblnHgBpknuqWvx9c"),
    SU26_ROSTER_TABLE_ID: z.string().default("tbl2VrP1uqwFt7QNQ"),
    SP26_ROSTER_TABLE_ID: z.string().default("tblv6XWgQNJ46cf6N"),
    SU26_SCHEDULE_TABLE_ID: z.string().default("tblqJlM85Em0AA767"),
    RHD_ATTENDINGS_TABLE_ID: z.string().default("tblxDJehirZSLFJna"),
    RHD_CLINICS_TABLE_ID: z.string().default("tbl0HrOcMHUQL0a6C"),
    // Email transport: "log" prints to stdout (default, safe for development/CI);
    // "graph" sends via Microsoft Graph delegated OAuth flow (requires the OAuth vars below);
    // "maileroo" sends via the Maileroo HTTP API (requires MAILEROO_API_KEY).
    //
    // Graph is bound to a Yale shared mailbox and inherits Exchange Online's
    // ~30 messages/minute submission cap; Maileroo is a dedicated ESP with no
    // comparable per-minute ceiling, sending from our own verified domain.
    // Teams DMs always use Graph regardless of this setting -- see
    // resolveTeamsTransport, which keys off "is a live transport selected", not
    // off "is Graph selected".
    EMAIL_TRANSPORT: z.enum(["log", "graph", "maileroo"]).default("log"),
    MAILEROO_API_KEY: z.string().optional(),
    // The verified-domain allowlist: which transport can DKIM-sign for which
    // From domain, as comma-separated "<domain>:<transport>" pairs, e.g.
    // "havenfreeclinic.org:maileroo,yale.edu:graph".
    //
    // Optional, and the shipped default lives in email/sending-domains.ts rather
    // than here, so the two domains stay readable next to the evidence for each.
    // This override exists because the thing that changes is a MAILEROO DASHBOARD
    // state, not code: a domain being verified or disabled there should be
    // reflectable without waiting on a code edit. Both directions have now been
    // exercised, the second the one to remember: yale.edu was Graph-signed until
    // Maileroo verified it on 2026-09-02, and "yale.edu:graph" is what puts it
    // back if Maileroo disables it again. An override REPLACES the default table.
    // Empty or whitespace-only means "not configured" (see parseSendingDomains)
    // -- an unset Vercel variable and vitest.setup.ts's env claim both arrive
    // as "". A domain listed twice takes its LAST verdict, which neither this
    // check nor the parser flags.
    SENDING_DOMAINS: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional()
    ),
    // The mailboxes that send through Microsoft Graph no matter what
    // SENDING_DOMAINS says about their domain, as a comma-separated list of
    // addresses. Optional; unset means "no address-level pins", which is exactly
    // the behaviour that existed before this variable.
    //
    // It exists because domain is not a fine enough key for the real rule. Graph
    // sends via /users/{from}/sendMail, so a From must be a mailbox INSIDE the
    // Microsoft tenant: a shared clinic mailbox is in Exchange Online and works,
    // a personal Yale mailbox is hosted on-premise and answers
    // 404 MailboxNotEnabledForRESTAPI. Both are @yale.edu, so no row of
    // SENDING_DOMAINS can separate them.
    //
    // No shipped default, and deliberately none: which mailboxes an org owns is
    // org-specific, and this product's org name, branding and departments are all
    // configurable. The clinic's own three are documented in .env.example and set
    // per deployment. See GRAPH_SENDER_ADDRESSES in email/sending-domains.ts for
    // what the empty default means for routing, and routing-gap.ts for the check
    // that surfaces it before someone switches transport.
    //
    // Empty or whitespace-only means "not configured", NOT "configured to
    // nothing": an unset Vercel variable and vitest.setup.ts's env claim both
    // arrive as "". A value that is non-empty but names no address refuses to
    // boot below.
    GRAPH_SENDER_ADDRESSES: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional()
    ),
    GRAPH_OAUTH_TENANT_ID: z.string().optional(),
    GRAPH_OAUTH_CLIENT_ID: z.string().optional(),
    GRAPH_OAUTH_CLIENT_SECRET: z.string().optional(),
    // Ask for the mail scopes only, dropping the Teams ones from the consent
    // request. Consent is all-or-nothing per authorize call: a registration that
    // has not consented to Chat.Create cannot grant Mail.Send either, it just
    // answers "Need admin approval" for the whole thing. Set this true to point
    // the mailer at a bare-bones registration and keep email flowing while a
    // fuller registration waits on tenant admin consent, then set it false and
    // reconnect once that consent lands. Teams features gate themselves off on
    // the stored scope string via teamsScopesGranted(), so they degrade rather
    // than break: the triage-chat screen refuses with a reconnect prompt, and
    // Teams notifications fall back to email.
    GRAPH_OAUTH_MAIL_ONLY: z
      .string()
      .default("false")
      .transform((v) => v === "true"),
    GRAPH_OAUTH_REDIRECT_URI: z
      .string()
      .default("http://localhost:3000/admin/email/oauth/callback"),
    EMAIL_SENDER: z.string().optional(),
    // Trusted public base URL for links embedded in outbound email (e.g. the
    // recruitment onboarding contract link). Deploy-time value; never derived
    // from the request Host header, which is attacker-controllable.
    // .url() so a scheme-less value (e.g. "staging.example.org") fails loudly at
    // boot instead of at render: this seeds the app.baseUrl setting's env default,
    // which flows unguarded into `new URL()` on the universal metadata path (#67).
    APP_BASE_URL: z.string().url().default("http://localhost:3000"),
    // Public origin of the application portal's custom subdomain (e.g.
    // https://apply.havenfreeclinic.org). Optional: when unset the portal stays
    // at <APP_BASE_URL>/apply and no host rewrite happens. Deploy-time value,
    // never derived from the request Host header.
    PORTAL_BASE_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
    // Optional label for a persistent non-production banner (e.g. "Staging").
    // When set, every page renders a top warning strip so a user can never
    // mistake the deploy for production. Left unset on production. Deploy-time
    // value; empty string is treated as unset.
    ENV_BANNER_LABEL: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
    // GitBook docs visitor authentication (custom JWT backend). When both are set,
    // /api/gitbook/auth signs an HS256 JWT with GITBOOK_JWT_KEY for the signed-in
    // person and redirects the visitor back into the published docs site. Optional:
    // when either is unset the endpoint responds 503 and the docs stay closed.
    //   GITBOOK_JWT_KEY  -- the per-site signing key from GitBook (Audience > Custom).
    //   GITBOOK_SITE_URL -- the published site base URL the visitor is returned to
    //                       (e.g. https://haven-free-clinic.gitbook.io/docs).
    GITBOOK_JWT_KEY: z.string().optional(),
    GITBOOK_SITE_URL: z.string().optional(),
    // The Microsoft Teams clinic Team's groupId. When set (and the Mailer OAuth is
    // connected with the Channel.ReadBasic.All scope), the home dashboard shows a
    // link to the current clinic week's channel. Optional: when unset, the card is
    // simply not rendered. The connected mailbox must be a member of this Team.
    TEAMS_CLINIC_GROUP_ID: z.string().optional(),
    // Uploads: local filesystem storage for HIPAA certificates.
    // Mount this as a persistent volume in production (SpinUp).
    UPLOAD_DIR: z.string().default("./uploads"),
    // Cloudflare R2 object storage, used in every deployed environment. All four
    // are required together: see the all-or-nothing superRefine below.
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET: z.string().optional(),
    // Yalies API key (https://yalies.io/api), used to auto-source Yale College
    // profile photos by netId. Optional: when unset, photo auto-sourcing is
    // inert and only self-uploaded photos exist. Server-only, never logged.
    // Requests MUST use https; Yalies revokes keys used over plain HTTP.
    YALIES_API_KEY: z.string().optional(),
    // Maximum allowed upload size in megabytes. Stored as a string in env; transformed to
    // a number. Rejected if not a positive finite number.
    // Default is 4 MB: every upload path except SCORM packages goes through a Server
    // Action, which the platform hard-limits to ~4.5 MB regardless of the app's own
    // limit, so a larger advertised limit just fails opaquely at the edge (#75). The
    // uploads.maxMb admin setting is likewise capped at 4 in the settings registry.
    //
    // CLAMPED to that same 4, not merely defaulted to it (audit 14,
    // max-upload-mb-env-default-bypasses-the-4mb-cap). The registry cap only
    // constrains what an admin can type into the settings form; the env value
    // flows around it, both as `uploads.maxMb`'s envDefault and directly through
    // config.MAX_UPLOAD_MB at the validation sites in my-info, recruitment
    // submissions, incidents, and support attachments. .env.example shipped
    // MAX_UPLOAD_MB=5 (a stale rationale: Airtable's 5 MB attachment cap, and the
    // Airtable mirror is gone), so any deployment copied from it advertised a
    // size that FUNCTION_PAYLOAD_TOO_LARGE rejects before app code runs.
    //
    // Clamped rather than rejected on purpose: any environment that copied the
    // old example has 5 set today, and refusing to boot is the one failure mode
    // worse than a too-generous limit. SCORM packages are unaffected -- they
    // bypass Server Actions entirely via a presigned R2 PUT with its own 75 MB
    // ceiling (src/app/api/learning/upload-url/route.ts).
    MAX_UPLOAD_MB: z
      .string()
      .default("4")
      .transform(Number)
      .pipe(
        z
          .number()
          .superRefine((val, ctx) => {
            if (Number.isNaN(val) || val <= 0) {
              ctx.addIssue({
                code: "custom",
                path: [],
                message: "MAX_UPLOAD_MB must be a positive number",
              });
            }
          })
          .transform((val) => Math.min(val, SERVER_ACTION_MAX_UPLOAD_MB))
      ),
    // Compliance reminder cadence: how many days between reminder emails.
    // Default is 7 (weekly). Rejected if not a positive finite number.
    COMPLIANCE_REMINDER_INTERVAL_DAYS: z
      .string()
      .default("7")
      .transform(Number)
      .pipe(
        z.number().superRefine((val, ctx) => {
          if (Number.isNaN(val) || val <= 0) {
            ctx.addIssue({
              code: "custom",
              path: [],
              message: "COMPLIANCE_REMINDER_INTERVAL_DAYS must be a positive number",
            });
          }
        })
      ),
    // Onboarding reminder cadence: how many days between onboarding-requirement
    // emails. Default is 1 (daily), much faster than the HIPAA cadence because these
    // are tasks a new member should finish in their first week. Rejected if not a
    // positive finite number.
    ONBOARDING_REMINDER_INTERVAL_DAYS: z
      .string()
      .default("1")
      .transform(Number)
      .pipe(
        z.number().superRefine((val, ctx) => {
          if (Number.isNaN(val) || val <= 0) {
            ctx.addIssue({
              code: "custom",
              path: [],
              message: "ONBOARDING_REMINDER_INTERVAL_DAYS must be a positive number",
            });
          }
        })
      ),
    // Maximum procedures per RHD clinic session. Stored as a string in env; transformed to
    // a number. Rejected if not a positive finite number.
    RHD_MAX_PROCEDURES: z
      .string()
      .default("3")
      .transform(Number)
      .pipe(
        z.number().superRefine((val, ctx) => {
          if (Number.isNaN(val) || val <= 0) {
            ctx.addIssue({
              code: "custom",
              path: [],
              message: "RHD_MAX_PROCEDURES must be a positive number",
            });
          }
        })
      ),
    // Clinic check-in geofence centre latitude. MUST be confirmed against the
    // actual clinic entrance before production use: a centre fifty metres off is
    // a fence that fails people at the door.
    CLINIC_CHECKIN_LATITUDE: z
      .string()
      .default("41.3025")
      .transform(Number)
      .pipe(
        z.number().superRefine((val, ctx) => {
          if (!Number.isFinite(val) || val < -90 || val > 90) {
            ctx.addIssue({
              code: "custom",
              path: [],
              message: "CLINIC_CHECKIN_LATITUDE must be between -90 and 90",
            });
          }
        })
      ),
    // Clinic check-in geofence centre longitude. See CLINIC_CHECKIN_LATITUDE.
    CLINIC_CHECKIN_LONGITUDE: z
      .string()
      .default("-72.937")
      .transform(Number)
      .pipe(
        z.number().superRefine((val, ctx) => {
          if (!Number.isFinite(val) || val < -180 || val > 180) {
            ctx.addIssue({
              code: "custom",
              path: [],
              message: "CLINIC_CHECKIN_LONGITUDE must be between -180 and 180",
            });
          }
        })
      ),
    // How near the geofence centre a volunteer must be to self check in, in metres.
    // Rejected if not a positive finite number.
    CLINIC_CHECKIN_RADIUS_METERS: z
      .string()
      .default("250")
      .transform(Number)
      .pipe(
        z.number().superRefine((val, ctx) => {
          if (!Number.isFinite(val) || val <= 0) {
            ctx.addIssue({
              code: "custom",
              path: [],
              message: "CLINIC_CHECKIN_RADIUS_METERS must be a positive number",
            });
          }
        })
      ),
    // Location fixes less precise than this (coords.accuracy, in metres) are
    // rejected as unusable rather than guessed at. Rejected if not a positive
    // finite number.
    CLINIC_CHECKIN_MAX_ACCURACY_METERS: z
      .string()
      .default("200")
      .transform(Number)
      .pipe(
        z.number().superRefine((val, ctx) => {
          if (!Number.isFinite(val) || val <= 0) {
            ctx.addIssue({
              code: "custom",
              path: [],
              message: "CLINIC_CHECKIN_MAX_ACCURACY_METERS must be a positive number",
            });
          }
        })
      ),
    // IANA display time zone for rendering real timestamps. Deploy-time seed;
    // admins can override live via the display.timeZone setting.
    DISPLAY_TIME_ZONE: z.string().default("America/New_York"),
    // walletwallet.dev API key for issuing Apple/Google Wallet passes (volunteer
    // passport). Optional: when unset, the wallet feature is off and no HTTP
    // call is ever attempted (see src/modules/passport/services/wallet-client.ts).
    WALLETWALLET_API_KEY: z.string().optional(),
    /// Pro tier unlocks the brand colour and the logo/icon/strip images. The
    /// clinic is on a time-limited trial, so this is a separate switch from the
    /// key: when the trial lapses, set it false and branded fields stop being
    /// sent, with the card falling back to the free tier's colorPreset. No code
    /// change, and no branded fields sent to an account that ignores them.
    // ---- Observability and integrations -----------------------------------
    // These were read straight off process.env and were absent from this schema
    // entirely, so they were neither typed nor discoverable and a typo in one
    // produced silence rather than an error (audit 14, OBS-07).
    //
    // Declared `.optional()` on purpose, NOT required-in-production. Telemetry
    // and a support-chat widget are not the same class of dependency as object
    // storage: losing R2 destroys uploads, whereas losing PostHog costs
    // visibility. Refusing to boot production because analytics is
    // misconfigured would convert an observability outage into a total one.
    NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: z.string().optional(),
    NEXT_PUBLIC_POSTHOG_HOST: z.string().optional(),
    POSTHOG_API_KEY: z.string().optional(),
    // Fails closed when unset: authorizeCron rejects every request, so all ten
    // scheduled jobs stop. That rejection is now logged (src/platform/cron.ts),
    // and the /admin cron panel flags every job stale via its firstSeen anchor.
    CRON_SECRET: z.string().optional(),
    NEXT_PUBLIC_INTERCOM_APP_ID: z.string().optional(),
    INTERCOM_ACCESS_TOKEN: z.string().optional(),
    INTERCOM_MESSENGER_SECRET: z.string().optional(),
    INTERCOM_WEBHOOK_SECRET: z.string().optional(),
    INTERCOM_BOT_ADMIN_ID: z.string().optional(),
    INTERCOM_MCP_BEARER_TOKEN: z.string().optional(),
    WALLETWALLET_PRO: z
      .preprocess((v) => (v === "" || v === undefined ? false : v === "true" || v === true), z.boolean())
      .default(false),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    // Demo/staging deploys log in via credentials (auth.ts), so Azure is optional.
    if (env.DEMO_MODE) return;
    // `next build` runs with NODE_ENV=production but without runtime secrets;
    // Azure vars are enforced at server boot, not at build time.
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    const required = [
      "AZURE_AD_CLIENT_ID",
      "AZURE_AD_CLIENT_SECRET",
      "AZURE_AD_TENANT_ID",
    ] as const;
    for (const key of required) {
      if (!env[key]) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "required in production",
        });
      }
    }
  })
  .superRefine((env, ctx) => {
    // When graph transport is selected, all OAuth credentials and the sender are required.
    // GRAPH_OAUTH_REDIRECT_URI always has a default so it is excluded from this check.
    if (env.EMAIL_TRANSPORT !== "graph") return;
    for (const key of [
      "GRAPH_OAUTH_TENANT_ID",
      "GRAPH_OAUTH_CLIENT_ID",
      "GRAPH_OAUTH_CLIENT_SECRET",
      "EMAIL_SENDER",
    ] as const) {
      if (!env[key]) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "required when EMAIL_TRANSPORT is graph",
        });
      }
    }
  })
  .superRefine((env, ctx) => {
    // Maileroo needs an API key and a From address. The address must be on a
    // domain verified in the Maileroo dashboard, which we cannot check here --
    // the admin confirms it with a sender test send.
    if (env.EMAIL_TRANSPORT !== "maileroo") return;
    for (const key of ["MAILEROO_API_KEY", "EMAIL_SENDER"] as const) {
      if (!env[key]) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "required when EMAIL_TRANSPORT is maileroo",
        });
      }
    }
  })
  .superRefine((env, ctx) => {
    // A malformed SENDING_DOMAINS override must refuse to boot rather than be
    // silently narrowed. parseSendingDomains skips an entry it cannot read, so a
    // typo'd "yale.edu:grap" would quietly drop yale.edu off the allowlist and
    // send every Yale identity out pinned to the fallback address -- a routing
    // change with no error anywhere. Same shape as ENTRY_RE in
    // email/sending-domains.ts; duplicated rather than imported because that
    // module reads this config and importing it back would be circular.
    if (!env.SENDING_DOMAINS) return;
    let pairs = 0;
    for (const entry of env.SENDING_DOMAINS.split(",")) {
      // An empty segment is a trailing comma or a stray double comma, not a
      // malformed pair. parseSendingDomains already reads "yale.edu:graph,"
      // correctly, and this config is loaded at import by most of the app, so
      // refusing it here would turn a typo on the emergency SENDING_DOMAINS lever
      // into an app-wide cold-start failure. On its own, an empty segment narrows
      // nothing -- but see the count below for when ALL of them are empty.
      if (entry.trim() === "") continue;
      if (/^[^\s@:,]+:(maileroo|graph)$/.test(entry.trim())) {
        pairs += 1;
        continue;
      }
      ctx.addIssue({
        code: "custom",
        path: ["SENDING_DOMAINS"],
        message: `"${entry.trim()}" is not a "<domain>:<transport>" pair with transport one of maileroo, graph`,
      });
    }
    // A non-empty value that yields NO domains -- "," or ",," -- is the failure
    // this whole check exists for, arrived at from the other side. It is not
    // whitespace-only, so it is not "not configured"; every segment is then
    // skipped, so the allowlist is empty; and an empty allowlist puts every send
    // on the pinned fallback with its configured From demoted to Reply-To, in
    // silence. Refuse, rather than fall back to the defaults, because that is
    // what every other branch in this file does with a configured-but-unusable
    // value: an operator who set this variable meant something by it, and
    // quietly substituting the shipped table would hide that they did not get it.
    if (pairs === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["SENDING_DOMAINS"],
        message:
          `"${env.SENDING_DOMAINS}" names no <domain>:<transport> pairs at all. An empty ` +
          `allowlist would silently pin every send to the email.sender setting. Leave the ` +
          `variable unset to use the shipped default table.`,
      });
    }
  })
  .superRefine((env, ctx) => {
    // GRAPH_SENDER_ADDRESSES gets the same treatment as SENDING_DOMAINS above,
    // and for reasons learned there rather than guessed at here.
    //
    // A MALFORMED ENTRY REFUSES TO BOOT. parseGraphSenderAddresses skips an entry
    // it cannot read, so a typo'd "hfc.admin@yale" would quietly drop that
    // mailbox off the Graph list and send its mail through Maileroo instead --
    // a transport change with no error anywhere, which is the exact failure this
    // whole feature exists to make visible.
    //
    // The address pattern is EMAIL_RE, IMPORTED rather than restated. The
    // SENDING_DOMAINS check a few lines up duplicates its regex because the
    // module that owns it reads this config and importing it back would be
    // circular; email/address.ts has no imports at all, so that argument does not
    // apply and the two halves cannot drift.
    if (!env.GRAPH_SENDER_ADDRESSES) return;
    let addresses = 0;
    for (const entry of env.GRAPH_SENDER_ADDRESSES.split(",")) {
      // An empty segment is a trailing comma, not a malformed address. This
      // config is loaded at import by most of the app, so refusing one would turn
      // a trailing comma into an app-wide cold-start failure. See the count below
      // for when EVERY segment is empty.
      if (entry.trim() === "") continue;
      // A COLON is rejected on top of EMAIL_RE, and only here. EMAIL_RE is
      // deliberately permissive about the domain part -- it is the shared
      // write-time pattern, not an RFC 5322 parser -- so it happily accepts
      // "hfc.admin@yale.edu:graph", reading ":graph" as part of the domain.
      // That is a mistake this variable actively invites, because the value
      // directly above it in .env.example IS a "<thing>:<transport>" list, and
      // its consequence is silent: the entry parses, matches no real From, and
      // the mailbox it was meant to pin quietly stays on the other transport.
      // Tightening EMAIL_RE itself would change every address the app accepts
      // anywhere, to fix a confusion that exists only between these two
      // neighbouring variables.
      if (EMAIL_RE.test(entry.trim()) && !entry.includes(":")) {
        addresses += 1;
        continue;
      }
      ctx.addIssue({
        code: "custom",
        path: ["GRAPH_SENDER_ADDRESSES"],
        message: entry.includes(":")
          ? `"${entry.trim()}" looks like a SENDING_DOMAINS pair. This variable takes bare email addresses, one per mailbox.`
          : `"${entry.trim()}" is not an email address`,
      });
    }
    // A non-empty value naming NO address -- "," or ",," -- refuses, even though
    // the resulting empty set is the same one an UNSET variable produces and is
    // perfectly safe. The two inputs are not the same statement: unset means
    // "this deployment pins nothing", while "," means an operator set the
    // variable, meant something by it, and got nothing. Accepting it silently
    // would hide that they did not get what they typed, which is the regression
    // the SENDING_DOMAINS check was extended to catch -- there a comma-only value
    // booted with an empty allowlist and pinned every send.
    if (addresses === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["GRAPH_SENDER_ADDRESSES"],
        message:
          `"${env.GRAPH_SENDER_ADDRESSES}" names no email addresses at all. Leave the variable ` +
          `unset if this deployment routes no address to Graph by address.`,
      });
    }
  })
  .superRefine((env, ctx) => {
    // R2 configuration is all-or-nothing. With a partial config, storage falls
    // back to local disk -- and on Vercel the function filesystem is ephemeral,
    // so uploads appear to succeed and then vanish on the next deploy, with no
    // error anywhere. Refuse to boot instead of losing files quietly.
    const keys = [
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET",
    ] as const;
    const present = keys.filter((key) => env[key]);
    if (present.length === 0 || present.length === keys.length) return;
    for (const key of keys) {
      if (!env[key]) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message:
            "required when any other R2_* variable is set (R2 config is all-or-nothing)",
        });
      }
    }
  })
  .superRefine((env, ctx) => {
    // The all-or-nothing check above only fires once SOME R2_* var is set, so a
    // deployment with NONE of them validated cleanly and silently selected the
    // local-disk driver (src/platform/storage/index.ts keys r2Active off
    // R2_BUCKET). That is the one case where the failure is invisible: a
    // half-configured store was already refused at boot, but a completely
    // unconfigured one booted fine and then broke every upload path in the app
    // at once -- HIPAA certificates, drawn signatures, incident and support
    // attachments, recruitment files, branding images, SCORM packages, member
    // photos -- and only at the moment a real user tried. On Vercel the function
    // filesystem is read-only outside /tmp, so the write throws; point UPLOAD_DIR
    // at /tmp instead and the write succeeds and the bytes vanish on the next
    // invocation, which is worse. Refuse to boot instead, matching what the
    // comment above already says this config wants.
    if (env.NODE_ENV !== "production") return;
    // Demo/staging deploys are the documented escape hatch for running without
    // the full infrastructure, and they never hold live volunteer data (see
    // DEMO_MODE's own comment), so they keep the local-disk fallback. The real
    // production deploy runs with DEMO_MODE off and is the one this guards.
    if (env.DEMO_MODE) return;
    // `next build` runs with NODE_ENV=production but without runtime secrets, so
    // this is a boot-time check, not a build-time one -- same carve-out and same
    // reason as the Azure block above.
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    if (!env.R2_BUCKET) {
      ctx.addIssue({
        code: "custom",
        path: ["R2_BUCKET"],
        message:
          "object storage is required in production: without it every upload falls back to the local filesystem, which is read-only or ephemeral on a deployed host",
      });
    }
  });

export type AppConfig = z.infer<typeof schema>;

/** Parse and validate env. Throws a readable error listing every problem. */
export function loadConfig(
  env: Record<string, string | undefined> = process.env
): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}

export const config = loadConfig();
