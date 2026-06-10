# Settings Phase 1 — Operational Settings + Behavior Switches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the admin Settings page with six operational scalars and two guarded behavior switches, migrating each `config.X` consumer to the Phase 0 resolver.

**Architecture:** Each setting is a registry entry (auto-rendered by the Phase 0 page). Group A scalars are plain entries with async call-site migrations. Group B switches add an optional `validate` cross-field guard (run on write) so an admin cannot enable `graph`/`mirror` without the required env secrets; their consumers (`emailTransportFromConfig`, the duplicated `mirrorTarget`) become async resolvers.

**Tech Stack:** Next.js 16, Prisma/PostgreSQL, Zod, Vitest. Builds on Phase 0: `getSetting`/`setSetting`/`getCategory` (`@/platform/settings/service`), `SETTINGS`/`SettingDef`/`define`/`getSettingDef` (`@/platform/settings/registry`), `config` + `AppConfig` (`@/platform/config`).

**Spec:** `docs/superpowers/specs/2026-06-09-settings-phase-1-operational-and-switches-design.md`

**Branch:** `feat/admin-configurable-settings` (same as Phase 0 / PR #20). Do NOT create a new branch.

**Environment:** Run DB tests with plain `npx vitest run <path>` (local test DB at localhost:5434 is up; vitest points DATABASE_URL there automatically — never set DATABASE_URL or use `--env-file`, which risks the live Neon DB).

---

## File Structure

- Modify `src/platform/settings/registry.ts` — add `validate?` to `SettingDef`, the `SettingValidateCtx` type, and 8 new entries.
- Modify `src/platform/settings/service.ts` — call `def.validate` in `setSetting`.
- Modify consumers (Group A): `submissions.ts`, `onboarding.ts`, `my-info.ts`, `reminders.ts`, `onboarding/actions.ts`, `channel-link.ts`.
- Modify `src/platform/email/transport.ts` — add async `resolveEmailTransport`; migrate 4 callers.
- Create `src/platform/airtable/mirror-target.ts` — shared async `mirrorTarget`; update `cron.ts`, `worker/index.ts`, `sync.ts`.
- Tests alongside each.

---

## Task 1: Operations scalars (uploads + compliance)

Adds `uploads.maxMb`, `compliance.reminderIntervalDays`, `compliance.escalationThreshold` and migrates their consumers.

**Files:**
- Modify: `src/platform/settings/registry.ts`
- Modify: `src/modules/recruitment/services/submissions.ts:108`
- Modify: `src/modules/recruitment/services/onboarding.ts:154,157`
- Modify: `src/modules/my-info/services/my-info.ts:239`
- Modify: `src/platform/email/reminders.ts:128-129`
- Test: `src/platform/settings/registry.test.ts` (extend)

- [ ] **Step 1: Add a failing resolver test**

Append to `src/platform/settings/service.test.ts` inside the existing `getSetting` describe (or a new describe):

```ts
describe("phase 1 operations scalars", () => {
  it("resolves uploads.maxMb from env default then DB override", async () => {
    expect(await getSetting<number>("uploads.maxMb")).toBe(5); // MAX_UPLOAD_MB default
    await prisma.setting.create({ data: { key: "uploads.maxMb", value: 12 } });
    _resetSettingsCache();
    expect(await getSetting<number>("uploads.maxMb")).toBe(12);
  });

  it("resolves the compliance scalars from env defaults", async () => {
    expect(await getSetting<number>("compliance.reminderIntervalDays")).toBe(7);
    expect(await getSetting<number>("compliance.escalationThreshold")).toBe(3);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/platform/settings/service.test.ts -t "operations scalars"`
Expected: FAIL — `Unregistered setting key: uploads.maxMb`.

- [ ] **Step 3: Add the three registry entries**

In `src/platform/settings/registry.ts`, add to the `SETTINGS` array (after the existing `rhd.maxProcedures` entry):

```ts
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
```

- [ ] **Step 4: Run the resolver test to verify it passes**

Run: `npx vitest run src/platform/settings/service.test.ts -t "operations scalars"`
Expected: PASS.

- [ ] **Step 5: Migrate the `uploads.maxMb` consumers**

In `src/modules/recruitment/services/submissions.ts`, line 108 currently:

```ts
    const capMb = Math.min(field?.validation?.maxFileMB ?? config.MAX_UPLOAD_MB, config.MAX_UPLOAD_MB);
```

Replace with (add `import { getSetting } from "@/platform/settings/service";` if absent):

```ts
    const maxMb = await getSetting<number>("uploads.maxMb");
    const capMb = Math.min(field?.validation?.maxFileMB ?? maxMb, maxMb);
```

In `src/modules/recruitment/services/onboarding.ts`, lines 154-157 currently:

```ts
    const capBytes = config.MAX_UPLOAD_MB * 1024 * 1024;
    // ...
        hipaaFile: `max ${config.MAX_UPLOAD_MB} MB`,
```

Replace by resolving once at the top of that block (add the `getSetting` import if absent):

```ts
    const maxMb = await getSetting<number>("uploads.maxMb");
    const capBytes = maxMb * 1024 * 1024;
    // ...
        hipaaFile: `max ${maxMb} MB`,
```

In `src/modules/my-info/services/my-info.ts`, line 239 currently:

```ts
  const maxBytes = config.MAX_UPLOAD_MB * 1024 * 1024;
```

Replace with (add `getSetting` import if absent):

```ts
  const maxBytes = (await getSetting<number>("uploads.maxMb")) * 1024 * 1024;
```

Confirm each enclosing function is `async` (all three are service functions that already `await`). If `config` is now unused in a file, remove its import.

- [ ] **Step 6: Migrate the compliance consumers**

In `src/platform/email/reminders.ts`, lines 128-129 currently:

```ts
  const intervalMs =
    config.COMPLIANCE_REMINDER_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
  const threshold = config.COMPLIANCE_ESCALATION_THRESHOLD;
```

Replace with (add `getSetting` import if absent):

```ts
  const intervalMs =
    (await getSetting<number>("compliance.reminderIntervalDays")) * 24 * 60 * 60 * 1000;
  const threshold = await getSetting<number>("compliance.escalationThreshold");
```

Confirm the enclosing function is `async` (it is — `reminders.ts` runs in the worker/cron and already awaits Prisma).

- [ ] **Step 7: Verify types, lint, and that affected suites still pass**

Run: `npm run typecheck` → clean.
Run: `npm run lint` → clean.
Run: `npx vitest run src/platform/email/reminders.test.ts src/modules/recruitment src/modules/my-info src/platform/settings`
Expected: PASS. If a migrated test relied on `config.MAX_UPLOAD_MB` etc., seed the corresponding setting or rely on the env default (which equals the old config default).

- [ ] **Step 8: Commit**

```bash
git add src/platform/settings/registry.ts src/platform/settings/service.test.ts \
  src/modules/recruitment/services/submissions.ts src/modules/recruitment/services/onboarding.ts \
  src/modules/my-info/services/my-info.ts src/platform/email/reminders.ts
git commit -m "feat(settings): operational scalars (upload size, compliance cadence) editable in admin"
```

---

## Task 2: Email/links/teams scalars

Adds `email.sender`, `app.baseUrl`, `teams.clinicGroupId`. Migrates `app.baseUrl` and `teams.clinicGroupId` consumers now; `email.sender` is consumed by the transport refactor in Task 3.

**Files:**
- Modify: `src/platform/settings/registry.ts`
- Modify: `src/app/recruitment/cycles/[id]/onboarding/actions.ts:23`
- Modify: `src/platform/teams/channel-link.ts:146`
- Test: `src/platform/settings/service.test.ts` (extend)

- [ ] **Step 1: Add a failing resolver test**

Append to `src/platform/settings/service.test.ts`:

```ts
describe("phase 1 email/links/teams scalars", () => {
  it("resolves app.baseUrl from env default", async () => {
    expect(await getSetting<string>("app.baseUrl")).toBe("http://localhost:3000");
  });
  it("resolves teams.clinicGroupId (empty string default when env unset)", async () => {
    expect(typeof (await getSetting<string>("teams.clinicGroupId"))).toBe("string");
  });
  it("resolves email.sender (string)", async () => {
    expect(typeof (await getSetting<string>("email.sender"))).toBe("string");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/platform/settings/service.test.ts -t "email/links/teams"`
Expected: FAIL — `Unregistered setting key: app.baseUrl`.

- [ ] **Step 3: Add the three registry entries**

`config.APP_BASE_URL` defaults to `"http://localhost:3000"`; `config.EMAIL_SENDER` and `config.TEAMS_CLINIC_GROUP_ID` are `string | undefined`. Coerce the optionals to `""` so the schema (`z.string()`) and the form input both have a defined value. Add to `SETTINGS`:

```ts
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
```

- [ ] **Step 4: Run the resolver test to verify it passes**

Run: `npx vitest run src/platform/settings/service.test.ts -t "email/links/teams"`
Expected: PASS.

- [ ] **Step 5: Migrate `app.baseUrl`**

In `src/app/recruitment/cycles/[id]/onboarding/actions.ts`, line 23 currently:

```ts
  const base = config.APP_BASE_URL;
```

Replace with (add `import { getSetting } from "@/platform/settings/service";` if absent):

```ts
  const base = await getSetting<string>("app.baseUrl");
```

Confirm the enclosing function is `async` (it is a server action). If `config` becomes unused, remove its import.

- [ ] **Step 6: Migrate `teams.clinicGroupId`**

In `src/platform/teams/channel-link.ts`, the default-parameter destructuring (line 146) currently:

```ts
    groupId = config.TEAMS_CLINIC_GROUP_ID,
```

A default parameter cannot `await`. Resolve inside the function body instead. Change the destructuring default to `undefined` and resolve after, treating empty string as "unset":

```ts
    groupId,
    loadClinicDates = loadActiveTermClinicDates,
  } = deps;

  const resolvedGroupId = groupId ?? (await getSetting<string>("teams.clinicGroupId"));
  if (!resolvedGroupId) return null;
```

Then replace the remaining uses of `groupId` in the function body with `resolvedGroupId`. Add the `getSetting` import. (The function is already `async`.) Confirm via the existing `channel-link` test that an empty/unset group id still returns `null`.

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm run lint` → clean.
Run: `npx vitest run src/platform/teams src/platform/settings`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/platform/settings/registry.ts src/platform/settings/service.test.ts \
  "src/app/recruitment/cycles/[id]/onboarding/actions.ts" src/platform/teams/channel-link.ts
git commit -m "feat(settings): email sender, app base URL, and Teams group editable in admin"
```

---

## Task 3: `validate` guard + `email.transport` switch + transport refactor

Adds the registry `validate` hook, wires it into `setSetting`, registers `email.transport` with its guard, and converts the email transport factory to an async resolver.

**Files:**
- Modify: `src/platform/settings/registry.ts` (type + entry)
- Modify: `src/platform/settings/service.ts` (guard call)
- Modify: `src/platform/email/transport.ts` (async resolver)
- Modify callers: `src/app/api/cron/drain/route.ts:18`, `src/app/api/cron/nightly/route.ts:40`, `src/app/api/cron/reminders/route.ts:23`, `worker/index.ts:67`
- Test: `src/platform/settings/service.test.ts`, `src/platform/email/transport.test.ts`

- [ ] **Step 1: Add the `validate` type to the registry**

In `src/platform/settings/registry.ts`, add a type import and extend `SettingDef`:

```ts
import { z } from "zod";
import { config, type AppConfig } from "@/platform/config";
```

Add the context type (near `SettingDef`):

```ts
export interface SettingValidateCtx {
  /** Env config, for checking that required secrets are present. */
  config: AppConfig;
  /** Resolve a sibling setting (DB override -> env default). */
  getSetting: <U>(key: string) => Promise<U>;
}
```

Add the optional field to `SettingDef<T>`:

```ts
  /**
   * Optional cross-field guard, run on WRITE only (after schema parse). Return
   * an error message to reject the change, or null to allow it. Omit for simple
   * settings.
   */
  validate?: (value: T, ctx: SettingValidateCtx) => Promise<string | null>;
```

- [ ] **Step 2: Add a failing guard test**

Append to `src/platform/settings/service.test.ts`:

```ts
describe("email.transport guard", () => {
  it("rejects graph when Graph OAuth env vars are absent", async () => {
    // The test env sets EMAIL_TRANSPORT=log and no GRAPH_OAUTH_* vars.
    await expect(setSetting("email.transport", "graph", null)).rejects.toBeInstanceOf(
      SettingValidationError
    );
    expect(await prisma.setting.findUnique({ where: { key: "email.transport" } })).toBeNull();
  });

  it("allows log without any prerequisites", async () => {
    await setSetting("email.transport", "log", null);
    expect(await getSetting<string>("email.transport")).toBe("log");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/platform/settings/service.test.ts -t "email.transport guard"`
Expected: FAIL — `Unregistered setting key: email.transport`.

- [ ] **Step 4: Register `email.transport` with its guard**

Add to `SETTINGS` in `registry.ts`:

```ts
  define<"log" | "graph">({
    key: "email.transport",
    category: "Email",
    label: "Email transport",
    help: "How outbound email is sent. 'log' prints to the server log; 'graph' sends via Microsoft Graph (requires OAuth credentials in the environment).",
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
```

- [ ] **Step 5: Wire the guard into `setSetting`**

In `src/platform/settings/service.ts`, inside `setSetting`, after the schema-parse block and before computing `before`/writing, add:

```ts
  if (def.validate) {
    const problem = await def.validate(parsed.data, { config, getSetting });
    if (problem) throw new SettingValidationError(key, problem);
  }
```

Add the imports at the top of `service.ts` if absent: `import { config } from "@/platform/config";` (the `getSetting` function is defined in this same module, so reference it directly).

- [ ] **Step 6: Run the guard test to verify it passes**

Run: `npx vitest run src/platform/settings/service.test.ts -t "email.transport guard"`
Expected: PASS (graph rejected with no creds; log accepted).

- [ ] **Step 7: Add a failing transport-resolver test**

In `src/platform/email/transport.test.ts`, add:

```ts
import { resolveEmailTransport } from "./transport";
import { _resetSettingsCache } from "@/platform/settings/service";
// ...
describe("resolveEmailTransport", () => {
  beforeEach(async () => { await resetDb(); _resetSettingsCache(); });
  it("returns a LogTransport when email.transport is log (default)", async () => {
    const t = await resolveEmailTransport();
    expect(t.constructor.name).toBe("LogTransport");
  });
});
```

(Use the file's existing imports for `resetDb`/`describe`/`it`; add only what's missing.)

- [ ] **Step 8: Run it to verify it fails**

Run: `npx vitest run src/platform/email/transport.test.ts -t "resolveEmailTransport"`
Expected: FAIL — `resolveEmailTransport` is not exported.

- [ ] **Step 9: Add the async resolver**

In `src/platform/email/transport.ts`, add (keep `emailTransportFromConfig` temporarily for any unmigrated caller, but it will be removed once all callers move):

```ts
import { getSetting } from "@/platform/settings/service";

/**
 * Resolve the email transport from admin settings (DB override -> env default).
 * Replaces emailTransportFromConfig for runtime call sites.
 */
export async function resolveEmailTransport(): Promise<EmailTransport> {
  const transport = await getSetting<"log" | "graph">("email.transport");
  if (transport === "graph") {
    const sender = await getSetting<string>("email.sender");
    return new GraphTransport({ getAccessToken, sender });
  }
  return new LogTransport();
}
```

- [ ] **Step 10: Run the resolver test to verify it passes**

Run: `npx vitest run src/platform/email/transport.test.ts -t "resolveEmailTransport"`
Expected: PASS.

- [ ] **Step 11: Migrate the four callers**

In each of `src/app/api/cron/drain/route.ts:18`, `src/app/api/cron/nightly/route.ts:40`, `src/app/api/cron/reminders/route.ts:23`, replace:

```ts
  const transport = emailTransportFromConfig(config);
```

with:

```ts
  const transport = await resolveEmailTransport();
```

Update each import from `{ emailTransportFromConfig }` to `{ resolveEmailTransport }`. Each enclosing handler is `async function GET`.

In `worker/index.ts:67`, replace:

```ts
  const emailTransport = emailTransportFromConfig(config);
```

with:

```ts
  const emailTransport = await resolveEmailTransport();
```

and update the import. (`main()` is async.)

After migrating all four, delete the now-unused `emailTransportFromConfig` export and its `AppConfig` import from `transport.ts` if nothing else uses them (check with `grep -rn emailTransportFromConfig src worker`).

- [ ] **Step 12: Verify**

Run: `npm run typecheck && npm run lint` → clean.
Run: `npx vitest run src/platform/email src/platform/settings`
Expected: PASS. If `transport.test.ts` previously tested `emailTransportFromConfig`, update those cases to `resolveEmailTransport` (seed `email.transport`/`email.sender` settings to exercise the graph branch).

- [ ] **Step 13: Commit**

```bash
git add src/platform/settings/registry.ts src/platform/settings/service.ts \
  src/platform/settings/service.test.ts src/platform/email/transport.ts \
  src/platform/email/transport.test.ts src/app/api/cron worker/index.ts
git commit -m "feat(settings): guarded email.transport switch with async transport resolver"
```

---

## Task 4: `airtable.mirrorEnabled` switch + shared mirrorTarget

Registers the guarded mirror toggle and consolidates the duplicated `mirrorTarget()` into one async helper.

**Files:**
- Modify: `src/platform/settings/registry.ts` (entry)
- Create: `src/platform/airtable/mirror-target.ts`
- Modify: `src/platform/cron.ts`, `worker/index.ts`, `src/modules/admin/services/sync.ts:77`
- Test: `src/platform/settings/service.test.ts`, `src/platform/airtable/mirror-target.test.ts`

- [ ] **Step 1: Add a failing guard test**

Append to `src/platform/settings/service.test.ts`:

```ts
describe("airtable.mirrorEnabled guard", () => {
  it("rejects enabling when AIRTABLE_PAT/base/people-table env vars are absent", async () => {
    await expect(setSetting("airtable.mirrorEnabled", true, null)).rejects.toBeInstanceOf(
      SettingValidationError
    );
    expect(await prisma.setting.findUnique({ where: { key: "airtable.mirrorEnabled" } })).toBeNull();
  });

  it("allows disabling without prerequisites", async () => {
    await setSetting("airtable.mirrorEnabled", false, null);
    expect(await getSetting<boolean>("airtable.mirrorEnabled")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/platform/settings/service.test.ts -t "airtable.mirrorEnabled guard"`
Expected: FAIL — `Unregistered setting key: airtable.mirrorEnabled`.

- [ ] **Step 3: Register `airtable.mirrorEnabled` with its guard**

Add to `SETTINGS` in `registry.ts`:

```ts
  define<boolean>({
    key: "airtable.mirrorEnabled",
    category: "Integrations",
    label: "Airtable mirror enabled",
    help: "When on, person changes are mirrored to Airtable. Requires AIRTABLE_PAT, mirror base ID, and people table ID in the environment.",
    input: { type: "boolean" },
    schema: z.boolean(),
    envDefault: () => config.AIRTABLE_MIRROR_ENABLED,
    secret: false,
    validate: async (value, { config }) => {
      if (value !== true) return null;
      const problems: string[] = (
        ["AIRTABLE_PAT", "AIRTABLE_MIRROR_BASE_ID", "AIRTABLE_MIRROR_PEOPLE_TABLE_ID"] as const
      ).filter((k) => !config[k]);
      return problems.length
        ? `Cannot enable the Airtable mirror until these env vars are set: ${problems.join(", ")}.`
        : null;
    },
  }),
```

- [ ] **Step 4: Run the guard test to verify it passes**

Run: `npx vitest run src/platform/settings/service.test.ts -t "airtable.mirrorEnabled guard"`
Expected: PASS.

- [ ] **Step 5: Add a failing mirror-target test**

Create `src/platform/airtable/mirror-target.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache } from "@/platform/settings/service";
import { mirrorTarget } from "./mirror-target";

beforeEach(async () => { await resetDb(); _resetSettingsCache(); });

describe("mirrorTarget", () => {
  it("reflects the airtable.mirrorEnabled setting (env default false)", async () => {
    expect((await mirrorTarget()).enabled).toBe(false);
    await prisma.setting.create({ data: { key: "airtable.mirrorEnabled", value: true } });
    _resetSettingsCache();
    expect((await mirrorTarget()).enabled).toBe(true);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/platform/airtable/mirror-target.test.ts`
Expected: FAIL — cannot resolve `./mirror-target`.

- [ ] **Step 7: Create the shared async `mirrorTarget`**

Copy the field-shape from the existing duplicate. Create `src/platform/airtable/mirror-target.ts`:

```ts
import { config } from "@/platform/config";
import { getSetting } from "@/platform/settings/service";
import { parseFieldMap } from "./mirror-map";
import type { MirrorTarget } from "./mirror";

/**
 * Build the Airtable mirror target. `enabled` comes from admin settings
 * (DB override -> env default); the base/table/field-map identifiers stay in
 * env (out of UI scope). Replaces the duplicated copies in cron.ts and the worker.
 */
export async function mirrorTarget(): Promise<MirrorTarget> {
  return {
    enabled: await getSetting<boolean>("airtable.mirrorEnabled"),
    baseId: config.AIRTABLE_MIRROR_BASE_ID ?? "",
    peopleTableId: config.AIRTABLE_MIRROR_PEOPLE_TABLE_ID ?? "",
    fieldMap: parseFieldMap(config.AIRTABLE_MIRROR_FIELD_MAP),
    hipaaFieldId: config.AIRTABLE_MIRROR_HIPAA_FIELD_ID ?? null,
    statusFieldId: config.AIRTABLE_MIRROR_STATUS_FIELD_ID ?? null,
  };
}
```

Verify the import paths for `parseFieldMap` and the `MirrorTarget` type against the existing `cron.ts`/`worker/index.ts` copies (match exactly what they import). If `parseFieldMap` lives in a different module, import it from there.

- [ ] **Step 8: Run the mirror-target test to verify it passes**

Run: `npx vitest run src/platform/airtable/mirror-target.test.ts`
Expected: PASS.

- [ ] **Step 9: Replace the duplicated copies**

In `src/platform/cron.ts`, delete the local `mirrorTarget()` function (the `export function mirrorTarget(): MirrorTarget { ... }` block) and import the shared one: `import { mirrorTarget } from "./airtable/mirror-target";`. Update every call site in `cron.ts` to `await mirrorTarget()` (the callers are in async route-drain code). Remove now-unused imports (`parseFieldMap`, `MirrorTarget`) if nothing else in `cron.ts` uses them.

In `worker/index.ts`, delete the local `mirrorTarget()` function and import the shared one: `import { mirrorTarget } from "../src/platform/airtable/mirror-target";`. Update its call sites to `await mirrorTarget()`. For the startup log at line 145, replace:

```ts
  console.log(
    `[worker] running. mirror=${config.AIRTABLE_MIRROR_ENABLED ? "ENABLED" : "disabled"} heartbeat=${HEARTBEAT_ID}`
  );
```

with:

```ts
  const mirrorOn = await getSetting<boolean>("airtable.mirrorEnabled");
  console.log(
    `[worker] running. mirror=${mirrorOn ? "ENABLED" : "disabled"} heartbeat=${HEARTBEAT_ID}`
  );
```

Add `import { getSetting } from "../src/platform/settings/service";` to `worker/index.ts` if absent. (`main()` is async; the log line is inside it.)

- [ ] **Step 10: Migrate the sync read**

In `src/modules/admin/services/sync.ts`, line 77 currently:

```ts
    mirrorEnabled: config.AIRTABLE_MIRROR_ENABLED,
```

Replace with (add `getSetting` import if absent):

```ts
    mirrorEnabled: await getSetting<boolean>("airtable.mirrorEnabled"),
```

Confirm the enclosing function is `async` (it is — it awaits Prisma above). Keep `config.AIRTABLE_MIRROR_BASE_ID` on the next line as-is (still env).

- [ ] **Step 11: Verify**

Run: `npm run typecheck && npm run lint` → clean.
Run: `npx vitest run src/platform/airtable src/modules/admin src/platform/settings`
Expected: PASS. If `sync.test.ts` asserted `mirrorEnabled` from env, seed the `airtable.mirrorEnabled` setting or rely on the env default (false).

- [ ] **Step 12: Commit**

```bash
git add src/platform/settings/registry.ts src/platform/settings/service.test.ts \
  src/platform/airtable/mirror-target.ts src/platform/airtable/mirror-target.test.ts \
  src/platform/cron.ts worker/index.ts src/modules/admin/services/sync.ts
git commit -m "feat(settings): guarded Airtable mirror toggle with shared async mirrorTarget"
```

---

## Task 5: Full verification

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS (all suites, including the new Phase 1 settings tests).

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: succeeds; `/admin/settings` present in the route manifest.

- [ ] **Step 4: Manual smoke (optional)**

`npm run dev`, sign in as Platform Admin, open `/admin/settings`. Expect grouped categories — **Operations** (RHD max, upload size, compliance interval/threshold), **Email** (transport select, sender, app base URL), **Integrations** (Teams group, Airtable mirror toggle). Confirm: setting `email.transport` to "Microsoft Graph (live email)" with no Graph env vars shows the guard error; toggling the Airtable mirror on with no PAT shows its guard error.

- [ ] **Step 5: Final commit (if anything uncommitted)**

```bash
git add -A
git commit -m "chore(settings): Phase 1 verification"
```

---

## Notes for the implementer

- **No `config.ts` changes.** Env vars remain seed defaults; boot validation is unaffected (env `EMAIL_TRANSPORT`/`AIRTABLE_MIRROR_ENABLED` stay at safe defaults).
- **Guard runs on write only.** `getSetting` never runs `validate` and never throws on these; runtime still depends on the env secret being present (same failure mode as env-only today).
- **Async ripple is contained.** Every migrated call site is already in an async function (verified: services, the onboarding server action, the three cron route `GET`s, the worker `main()`).
- **`define<T>()` keeps entries type-checked.** Use it for every new entry, including the `validate` ones (the guard is typed to the entry's `T`).
- **Secrets stay in env.** Do not register `GRAPH_OAUTH_CLIENT_SECRET`, `AIRTABLE_PAT`, or the Airtable base/table IDs.
