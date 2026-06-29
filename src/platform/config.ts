import { z } from "zod";

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
    SU26_SCHEDULE_TABLE_ID: z.string().default("tblqJlM85Em0AA767"),
    RHD_ATTENDINGS_TABLE_ID: z.string().default("tblxDJehirZSLFJna"),
    RHD_CLINICS_TABLE_ID: z.string().default("tbl0HrOcMHUQL0a6C"),
    // Email transport: "log" prints to stdout (default, safe for development/CI);
    // "graph" sends via Microsoft Graph delegated OAuth flow (requires the OAuth vars below).
    EMAIL_TRANSPORT: z.enum(["log", "graph"]).default("log"),
    GRAPH_OAUTH_TENANT_ID: z.string().optional(),
    GRAPH_OAUTH_CLIENT_ID: z.string().optional(),
    GRAPH_OAUTH_CLIENT_SECRET: z.string().optional(),
    GRAPH_OAUTH_REDIRECT_URI: z
      .string()
      .default("http://localhost:3000/admin/email/oauth/callback"),
    EMAIL_SENDER: z.string().optional(),
    // Trusted public base URL for links embedded in outbound email (e.g. the
    // recruitment onboarding contract link). Deploy-time value; never derived
    // from the request Host header, which is attacker-controllable.
    APP_BASE_URL: z.string().default("http://localhost:3000"),
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
    // Maximum allowed upload size in megabytes. Stored as a string in env; transformed to
    // a number. Rejected if not a positive finite number.
    // Default is 5 MB because Airtable's content upload API caps attachments at 5 MB.
    MAX_UPLOAD_MB: z
      .string()
      .default("5")
      .transform(Number)
      .pipe(
        z.number().superRefine((val, ctx) => {
          if (Number.isNaN(val) || val <= 0) {
            ctx.addIssue({
              code: "custom",
              path: [],
              message: "MAX_UPLOAD_MB must be a positive number",
            });
          }
        })
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
    // Number of reminder emails sent before escalating to the director.
    // Default is 3. Rejected if not a positive finite number.
    COMPLIANCE_ESCALATION_THRESHOLD: z
      .string()
      .default("3")
      .transform(Number)
      .pipe(
        z.number().superRefine((val, ctx) => {
          if (Number.isNaN(val) || val <= 0) {
            ctx.addIssue({
              code: "custom",
              path: [],
              message: "COMPLIANCE_ESCALATION_THRESHOLD must be a positive number",
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
