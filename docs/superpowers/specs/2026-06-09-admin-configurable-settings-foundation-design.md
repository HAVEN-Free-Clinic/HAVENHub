# Admin-Configurable Settings — Phase 0: Foundation

**Date:** 2026-06-09
**Status:** Approved design, ready for implementation planning
**Author:** Jack C (with Claude)

## Goal

Make HAVEN Hub configurable through the admin UI instead of code and environment
variables, so a non-developer admin can change how the app behaves after the
current maintainer leaves. This is a **single-clinic, handoff-durability**
effort — not multi-tenancy / white-labeling.

The full effort spans four subsystems; this spec covers **Phase 0**, the shared
foundation that the other three phases build on.

## Scope of the overall effort (context)

Everything currently hardcoded or env-only should become admin-editable, **except
bootstrap secrets**, which stay in env for security (they would otherwise be
readable in the DB, logs, and audit trails):

- Stay in env, never in the UI: `DATABASE_URL`, `AUTH_SECRET`,
  `AZURE_AD_CLIENT_SECRET`, `GRAPH_OAUTH_CLIENT_SECRET`, `AIRTABLE_PAT`, and the
  auth-bootstrap IDs (`AZURE_AD_*`, `GRAPH_OAUTH_CLIENT_ID/TENANT_ID`,
  `GRAPH_OAUTH_REDIRECT_URI`), plus pure-infra values (`UPLOAD_DIR`, `NODE_ENV`,
  `DEMO_MODE`).

### Phase decomposition

- **Phase 0 — Settings foundation (this spec).** DB-backed settings store, a
  typed registry, an async resolver service with caching, the admin Settings
  hub, and one canary setting migrated end-to-end.
- **Phase 1 — Operational settings + Integration IDs.** Registry entries +
  call-site migrations for `MAX_UPLOAD_MB`,
  `COMPLIANCE_REMINDER_INTERVAL_DAYS`, `COMPLIANCE_ESCALATION_THRESHOLD`,
  `EMAIL_SENDER`, `APP_BASE_URL`, `TEAMS_CLINIC_GROUP_ID`, `EMAIL_TRANSPORT`,
  and the Airtable base/table IDs + mirror toggle/field-maps.
- **Phase 2 — Branding.** App name, logo, favicon, the HAVEN wordmark/mark, and
  brand colors. Involves file uploads and a dynamic favicon route.
- **Phase 3 — Departments CRUD.** Add/edit/deactivate departments and edit
  delegation relationships. Already relational data; needs an admin screen.

Each later phase adds registry rows and migrates its own call sites — **no new
infrastructure** after Phase 0.

## Phase 0 design

### 1. Data model

One new Prisma model. It stores **only overrides**; all metadata (category,
label, type, default) lives in the code registry.

```prisma
model Setting {
  key         String   @id          // e.g. "rhd.maxProcedures"
  value       Json                  // validated against the registry schema
  updatedById String?               // Person who last changed it (null = seed/system)
  updatedAt   DateTime @updatedAt
}
```

Audit trail reuses the existing `AuditLog`:
`action: "setting.update"`, `entityType: "Setting"`, `entityId: <key>`,
`before`/`after` set to the resolved values.

### 2. The registry

A single code file declares every admin-editable setting exactly once. This is
the keystone: the admin form auto-renders from it, so adding a future setting is
a one-line entry with no new screen or query.

```ts
// src/platform/settings/registry.ts
export interface SettingDef<T> {
  key: string;                 // dotted, stable identifier
  category: string;            // group heading in the UI
  label: string;               // form field label
  help: string;                // help text under the field
  input:                       // render hint for the auto-generated form
    | { type: "number"; min?: number; max?: number }
    | { type: "text" }
    | { type: "textarea" }
    | { type: "boolean" }
    | { type: "select"; options: { value: string; label: string }[] };
  schema: z.ZodType<T>;        // validates both DB and form input
  envDefault: () => T;         // seed value, sourced from `config` (env)
  secret: false;               // secrets are never registered (kept for clarity/guarding)
}
```

Phase 0 registers exactly one entry — the canary (see §5). Phases 1–3 add the
rest. A unit test asserts every entry is well-formed and keys are unique.

### 3. The resolver service

```ts
// src/platform/settings/service.ts
getSetting<T>(key): Promise<T>            // DB override → envDefault → (throws if key unregistered)
getCategory(category): Promise<Resolved[]> // resolved values + defs, for rendering a form group
setSetting(key, value, actorPersonId): Promise<void> // validate → write → audit → invalidate cache
```

**Resolution order:** a DB value that passes the registry `schema` wins; an
invalid/corrupt DB value logs a warning and falls back to `envDefault()` — it
**never crashes the app**. An unregistered key is a programming error and throws.

**Caching across processes:** an in-memory `Map` with a short TTL (~30s). The
writing process invalidates its own cache immediately on `setSetting`; the
worker and other processes converge within the TTL. Settings change rarely, so
this favors simplicity over instant cross-process propagation.

> Alternative considered and deferred: a single `version` counter row in the DB
> that processes check to force-invalidate. More moving parts; revisit only if
> the 30s window proves too slow in practice.

### 4. Admin UI

- New nav tab **Settings** → `/admin/settings`, added as a one-line entry in the
  admin module manifest's `nav`.
- New permission `admin.manage_settings` added to the admin manifest
  `permissions[]`; the page is gated with `requirePermission("admin.manage_settings")`.
- The page calls `getCategory()` per category and auto-renders a typed form group
  for each (number/text/textarea/boolean/select from `input.type`).
- A single server action `updateSetting(key, value)` validates against the
  registry schema, calls `setSetting`, and `revalidatePath`s the page.
- Each field offers **"Reset to default"**, which clears the DB override (deletes
  the `Setting` row) so the value falls back to env.

### 5. Migration strategy

`config.ts` is unchanged for bootstrap and secrets — nothing existing breaks.
Each registry entry's `envDefault()` reads from the existing `config` object, so
env values become **seed defaults**. Per setting, `config.X` reads migrate to
`await getSetting(...)`.

**Phase 0 canary: `rhd.maxProcedures`** (currently `config.RHD_MAX_PROCEDURES`,
with a single real consumer at `src/modules/schedule/services/builder.ts:965` —
the other matches are the env definition and its tests). Phase 0 registers it,
migrates that consumer, and proves the full loop: editing the value in
`/admin/settings` changes app behavior live (within the cache TTL for the
worker). This is the demonstrable vertical slice.

### 6. Error handling & edge cases

- Corrupt/invalid DB value → warn + fall back to env default; never throw to the
  user.
- Unregistered key passed to the service → throw (developer error).
- Concurrent edits → last-write-wins (acceptable for this low-frequency surface).
- Worker/other processes pick up changes within the cache TTL.

## Testing

- **Resolver unit tests:** DB-over-env precedence; TTL cache behavior; invalid DB
  value falls back to env with a warning; unregistered key throws.
- **Registry test:** every entry has all required fields; keys are unique;
  `envDefault()` returns a value that passes its own `schema`.
- **Admin action test:** invalid input is rejected; a valid write produces an
  `AuditLog` row; the RBAC gate denies users lacking `admin.manage_settings`.
- **Canary integration:** the `rhd.maxProcedures` consumer (`builder.ts`) reads
  the resolved value (DB override when present, else env).

## Out of scope for Phase 0

- Any setting other than the canary (Phases 1–3).
- Branding assets, dynamic favicon, departments CRUD.
- Multi-tenancy / per-org settings.
- Migrating secrets or auth-bootstrap values out of env.

## Files (anticipated)

- `prisma/schema.prisma` — add `Setting` model + migration.
- `src/platform/settings/registry.ts` — setting definitions (canary only in P0).
- `src/platform/settings/service.ts` — resolver, cache, `setSetting`.
- `src/platform/settings/*.test.ts` — resolver + registry tests.
- `src/app/admin/settings/page.tsx` — settings hub (auto-rendered forms).
- `src/app/admin/settings/actions.ts` — `updateSetting` server action + test.
- `src/platform/modules/registry.ts` — add Settings nav item + `admin.manage_settings`.
- Canary call site (`src/modules/schedule/services/builder.ts`) — migrate the
  single `config.RHD_MAX_PROCEDURES` consumer to `getSetting`.
