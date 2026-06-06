import { z } from "zod";

const schema = z
  .object({
    DATABASE_URL: z.string().min(1),
    AUTH_SECRET: z.string().min(1),
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
    // Mirror: WRITES. Disabled by default; points at a sandbox base until FA26 cutover.
    AIRTABLE_MIRROR_ENABLED: z
      .string()
      .default("false")
      .transform((v) => v === "true"),
    AIRTABLE_MIRROR_BASE_ID: z.string().optional(),
    AIRTABLE_MIRROR_PEOPLE_TABLE_ID: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
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
    // superRefine runs post-transform: AIRTABLE_MIRROR_ENABLED is already a boolean here.
    if (env.AIRTABLE_MIRROR_ENABLED === true) {
      for (const key of [
        "AIRTABLE_PAT",
        "AIRTABLE_MIRROR_BASE_ID",
        "AIRTABLE_MIRROR_PEOPLE_TABLE_ID",
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "required when the mirror is enabled",
          });
        }
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
