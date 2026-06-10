# Admin-Configurable Settings — Phase 1: Operational Settings + Behavior Switches

**Date:** 2026-06-09
**Status:** Design for approval
**Depends on:** Phase 0 foundation (`docs/superpowers/specs/2026-06-09-admin-configurable-settings-foundation-design.md`), shipped in PR #20.

## Goal

Populate the admin Settings page with the rest of the safe, non-secret operational
configuration, plus two behavior switches guarded so an admin cannot put the app
into a broken state. Each setting is a registry entry (auto-rendered by the
Phase 0 page) plus a migration of its `config.X` call sites to `getSetting`.

## Scope

### Group A — operational scalars (six settings, straightforward)

| Setting key | Env source | Input | Category | Consumers (all async) |
| --- | --- | --- | --- | --- |
| `uploads.maxMb` | `MAX_UPLOAD_MB` | number (min 1) | Operations | `submissions.ts:108`, `onboarding.ts:154,157`, `my-info.ts:239` |
| `compliance.reminderIntervalDays` | `COMPLIANCE_REMINDER_INTERVAL_DAYS` | number (min 1) | Operations | `reminders.ts:128` |
| `compliance.escalationThreshold` | `COMPLIANCE_ESCALATION_THRESHOLD` | number (min 1) | Operations | `reminders.ts:129` |
| `email.sender` | `EMAIL_SENDER` | text | Email | `transport.ts:97` (graph branch) |
| `app.baseUrl` | `APP_BASE_URL` | text | Email | `onboarding/actions.ts:23` |
| `teams.clinicGroupId` | `TEAMS_CLINIC_GROUP_ID` | text | Integrations | `channel-link.ts:146` |

These are non-secret, read in async service/action/worker code, and have no
behavior-switch risk. Each migrates `config.X` → `await getSetting<T>("key")`.

### Group B — behavior switches (two settings, guarded)

| Setting key | Env source | Input | Category | Consumers |
| --- | --- | --- | --- | --- |
| `email.transport` | `EMAIL_TRANSPORT` | select (`log`/`graph`) | Email | `transport.ts:94` |
| `airtable.mirrorEnabled` | `AIRTABLE_MIRROR_ENABLED` | boolean | Integrations | `cron.ts:29`, `sync.ts:77`, `worker/index.ts:27,145` |

These flip external behavior and depend on **env secrets that stay in env**:
- `email.transport = "graph"` requires `GRAPH_OAUTH_TENANT_ID`,
  `GRAPH_OAUTH_CLIENT_ID`, `GRAPH_OAUTH_CLIENT_SECRET` (secrets) and a non-empty
  resolved `email.sender`.
- `airtable.mirrorEnabled = true` requires `AIRTABLE_PAT` (secret),
  `AIRTABLE_MIRROR_BASE_ID`, `AIRTABLE_MIRROR_PEOPLE_TABLE_ID` (these IDs stay in
  env — they are out of Phase 1 UI scope).

### Out of scope

- Secrets (`GRAPH_OAUTH_CLIENT_SECRET`, `AIRTABLE_PAT`, etc.) — stay in env.
- Airtable base/table IDs for reads (`HAVEN_MGMT_BASE_ID`, `ALL_PEOPLE_TABLE_ID`,
  `SU26_*`, `RHD_*_TABLE_ID`) and the mirror's companion IDs/field-map — consumed
  only by CLI import scripts (which read env), so UI editing has no runtime
  effect. Excluded to avoid a misleading UI.
- `UPLOAD_DIR`, `NODE_ENV`, `DEMO_MODE`, `GRAPH_OAUTH_REDIRECT_URI` — infra/boot.

## Design

### 1. Registry extension: a cross-field validation guard

Phase 0's `SettingDef` validates a value in isolation (`schema`). Group B needs
validation against *other state* (env secrets, sibling settings). Add an optional
guard:

```ts
export interface SettingDef<T> {
  // ...existing fields...
  /**
   * Optional cross-field guard run on WRITE only (after schema parse). Returns
   * an error message to reject the change, or null to allow it. Has access to
   * env config and the resolver for sibling settings. Omit for simple settings.
   */
  validate?: (value: T, ctx: SettingValidateCtx) => Promise<string | null>;
}

export interface SettingValidateCtx {
  config: AppConfig;                       // env, for secret presence checks
  getSetting: <U>(key: string) => Promise<U>;
}
```

The guard runs **only in `setSetting`** (write path), never in `getSetting`
(read path stays fast and never throws). Reads still resolve DB→env as in Phase 0;
runtime correctness of a switched value still depends on the env secret being
present (same as today's env-only behavior). The guard's job is to stop an admin
from *enabling* a switch whose prerequisites are absent.

### 2. Service change

`setSetting` (Phase 0) currently: schema-parse → write → audit. Insert the guard:

```ts
const parsed = def.schema.safeParse(rawValue);
if (!parsed.success) throw new SettingValidationError(key, ...);
if (def.validate) {
  const problem = await def.validate(parsed.data, { config, getSetting });
  if (problem) throw new SettingValidationError(key, problem);
}
// ...existing write + audit...
```

No change to `getSetting`, `getCategory`, `resetSetting`, or the cache.
(`resetSetting` clears an override back to the env default, which is always
`log`/`false`/the env scalar — inherently safe, so it needs no guard.)

### 3. Guard definitions

```ts
// email.transport
validate: async (value, { config, getSetting }) => {
  if (value !== "graph") return null;
  const problems: string[] = (["GRAPH_OAUTH_TENANT_ID","GRAPH_OAUTH_CLIENT_ID","GRAPH_OAUTH_CLIENT_SECRET"] as const)
    .filter((k) => !config[k]);
  const sender = await getSetting<string>("email.sender");
  if (!sender) problems.push("a sender address (set Email > Sender first)");
  return problems.length
    ? `Cannot enable graph email until these are configured: ${problems.join(", ")}.`
    : null;
},

// airtable.mirrorEnabled
validate: async (value, { config }) => {
  if (value !== true) return null;
  const missing = (["AIRTABLE_PAT","AIRTABLE_MIRROR_BASE_ID","AIRTABLE_MIRROR_PEOPLE_TABLE_ID"] as const)
    .filter((k) => !config[k]);
  return missing.length
    ? `Cannot enable the Airtable mirror until these env vars are set: ${missing.join(", ")}.`
    : null;
},
```

### 4. Consumer migrations

**Group A** — replace `config.X` with `await getSetting<T>("key")` at each listed
site. All are already async functions.

**Email transport** — `emailTransportFromConfig(config: AppConfig)` is synchronous
and reads `EMAIL_TRANSPORT` + `EMAIL_SENDER`. Convert to an async resolver:

```ts
export async function resolveEmailTransport(): Promise<EmailTransport> {
  const transport = await getSetting<"log" | "graph">("email.transport");
  if (transport === "graph") {
    const sender = await getSetting<string>("email.sender");
    return new GraphTransport({ getAccessToken, sender });
  }
  return new LogTransport();
}
```

Find and update every caller of `emailTransportFromConfig` (mailer entry points:
reminders, campaign dispatch, email-send queue). Keep the old signature only if a
caller cannot be made async; the plan must enumerate callers explicitly.

**Airtable mirror** — `mirrorTarget()` is duplicated in `cron.ts` and
`worker/index.ts`. Consolidate into one async helper that resolves `enabled` from
the setting and the rest from env:

```ts
// src/platform/airtable/mirror-target.ts (new, shared)
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

Both `cron.ts` and `worker/index.ts` import this shared helper and `await` it
where they currently call their local `mirrorTarget()`. The worker startup log
line (`worker/index.ts:145`) reads the value once at boot — change it to read at
that point via `await getSetting`, accepting that the log reflects boot-time
state (the actual per-run reconcile reads fresh, within the 30s cache TTL).
`sync.ts:77` (`mirrorEnabled: config.AIRTABLE_MIRROR_ENABLED`) is in an async
service function — migrate directly.

### 5. config.ts

Unchanged. The env vars remain as seed defaults (`EMAIL_TRANSPORT` defaults
`log`, `AIRTABLE_MIRROR_ENABLED` defaults `false`), and the existing boot-time
`superRefine` checks still validate the *env* values (which stay at their safe
defaults), so boot validation is unaffected. The DB override + write guard govern
the UI path.

## Testing

- **Registry test:** the two Group B entries have a `validate`; all entries' env
  defaults still pass their `schema`; keys unique.
- **Service guard tests:** `setSetting("email.transport","graph")` throws
  `SettingValidationError` when graph env vars absent, succeeds when present (+ a
  sender set); `setSetting("airtable.mirrorEnabled",true)` throws when
  `AIRTABLE_PAT`/base/people-table absent, succeeds when present. Mock `config`
  presence via the test env.
- **Resolver tests:** each new key resolves DB override → env default (extend the
  Phase 0 table-driven approach).
- **Transport test:** `resolveEmailTransport` returns `LogTransport` for `log`,
  `GraphTransport` for `graph`.
- **Mirror-target test:** `mirrorTarget()` reflects the DB override for `enabled`
  and env for the rest.
- **Migration safety:** existing `transport.test.ts`, `reminders.test.ts`,
  `mirror.test.ts`, and `sync.test.ts` still pass after call-site migration
  (adjust them to seed settings / stub `getSetting` as needed).

## Risks & mitigations

- **Async ripple** from the transport factory and `mirrorTarget()` — contained by
  enumerating every caller in the plan; all known callers are already async
  (services, server actions, worker, cron route handlers).
- **Switched value with env secret later removed** — read path does not re-guard,
  so a `graph` override with creds since deleted would fail at send time (same
  failure mode as env-only today). Acceptable; the write guard covers the UI.
- **Worker freshness** — `mirrorEnabled` changes propagate within the Phase 0
  30s cache TTL; documented, not instant. Acceptable for this low-frequency flag.

## Files (anticipated)

- `src/platform/settings/registry.ts` — add 8 entries (2 with `validate`).
- `src/platform/settings/service.ts` — call `def.validate` in `setSetting`; export/extend `SettingValidateCtx`.
- `src/platform/settings/*.test.ts` — guard + resolver tests.
- `src/platform/airtable/mirror-target.ts` — new shared async `mirrorTarget`.
- `src/platform/cron.ts`, `worker/index.ts` — use shared `mirrorTarget`; remove local copies.
- `src/platform/email/transport.ts` — add async `resolveEmailTransport`; migrate callers.
- `src/modules/admin/services/sync.ts` — migrate `mirrorEnabled` read.
- Group A call sites — migrate `config.X` → `getSetting`.
