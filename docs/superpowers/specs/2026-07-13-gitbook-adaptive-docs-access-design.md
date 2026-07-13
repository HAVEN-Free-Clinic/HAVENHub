# GitBook Adaptive Docs Access — Design

**Date:** 2026-07-13
**Branch:** `feat/gitbook-adaptive-access`
**Status:** Approved design, pending implementation plan

## Goal

Make the HAVEN Hub documentation site (docs.havenfreeclinic.org) show each signed-in
person only the docs for features they can actually use in the app. A recruitment
reviewer sees recruitment docs; a plain volunteer does not. This is done with GitBook's
**Adaptive content**: our visitor-authentication backend already signs a JWT for each
docs visitor; we enrich that JWT with the person's effective permissions, define a
matching visitor-claims schema in GitBook, and gate pages/sections with conditions that
read those claims.

## Background — current state

- **Docs auth today:** `GET /api/gitbook/auth` (`src/app/api/gitbook/auth/route.ts`)
  requires a signed-in, active HAVEN person, then signs a short-lived HS256 JWT with
  `GITBOOK_JWT_KEY` containing `{ name, email, iat, exp }` and redirects the visitor back
  to the site with `?jwt_token=…`. The whole site is login-gated; every authenticated
  person currently sees **all** docs.
- **Permissions:** `getEffectivePermissions(personId)` (`src/platform/rbac/engine.ts`)
  returns a `Set<string>` of permission strings (e.g. `schedule.view`,
  `learning.manage_courses`). `hasPermission(set, perm)` applies the `*` wildcard rule
  (Platform Admin holds `*`).
- **Module registry:** `MODULES` (`src/platform/modules/registry.ts`) is the single
  source of truth for every declared permission. Each module lists `permissions: string[]`
  and an optional `accessPermission`. Modules with no `accessPermission` (my-info,
  incidents, support) are open to any signed-in person.
- **Docs structure:** ~11 section landings mirroring the module registry, with 50+
  task-oriented sub-pages (one per app screen). Section = app area; sub-pages map to the
  screen's gating permission.

## Decisions (and alternatives discarded)

1. **Granularity: per-permission (fine-grained), not per-module.** Lets us hide
   individual guide pages (e.g. "Manage courses") from someone who only has base module
   access. *Discarded:* module-level-only (too coarse — can't hide manager-only pages).
2. **Claim shape: a nested `can` object of booleans**, keyed by module then action, so
   conditions read as clean dot access: `visitor.claims.can.learning.manage_courses`.
   *Discarded:* a flat map with dotted keys (`can["learning.manage_courses"]`) — forces
   bracket syntax and risks GitBook's condition builder misreading `.` as nesting.
   *Discarded:* a raw permissions **array** — arrays are not a documented adaptive-schema
   type and array-membership conditions are undocumented in GitBook.
3. **Catalog source: `MODULES[].permissions`.** Everything (claims + schema) is derived
   from that one list, so they cannot drift. A test enforces this.
4. **Work split:** repo delivers the code + the schema JSON artifact + the page→condition
   mapping table. We push the schema to the live site via the GitBook MCP
   (`updateSiteAdaptiveSchema`); the user enables Adaptive content in GitBook and applies
   the per-page conditions in the editor from the mapping table.
5. **Failure mode: propagate.** `getEffectivePermissions` adds DB queries to the auth
   route, which already depends on the DB (`getActivePerson`). A transient DB failure
   blocks docs auth (as it would today) rather than failing open and leaking gated
   sections.

## Claim shape (concrete)

Signed alongside the existing `name` / `email` / `iat` / `exp` claims:

```jsonc
"can": {
  "schedule":    { "view": true,  "edit_own_dept": false, "edit_all": false, "manage_requests": false },
  "volunteers":  { "view": false, "manage_compliance": false, "manage_offboarding": false, "verify_spanish": false },
  "incidents":   { "manage": false, "view_strikes": false },
  "clinic":      { "access": false },
  "admin":       { "access": false, "manage_people": false, "manage_terms": false, "manage_roles": false,
                   "view_audit": false, "manage_sync": false, "manage_email_templates": false,
                   "send_email_campaign": false, "manage_settings": false, "manage_departments": false,
                   "manage_subcommittees": false, "manage_roster": false },
  "recruitment": { "access": false, "manage_cycles": false, "review_all": false },
  "learning":    { "access": true,  "manage_courses": false, "view_progress": false },
  "support":     { "manage_requests": false }
}
```

- Built by iterating the catalog, splitting each `namespace.action` on its **first** dot,
  and setting each leaf via `hasPermission(perms, permission)` — so Platform Admin (`*`)
  gets every leaf `true`.
- `my-info` declares no permissions, so it has no `can` entry; its docs are always
  visible (no condition). Same for the open sections of incidents/support.

## Code units (this worktree)

All new logic is pure and unit-testable; the route wiring is ~3 lines.

### `src/platform/gitbook/adaptive-claims.ts` (new)
- `ADAPTIVE_PERMISSION_CATALOG: string[]` — sorted, de-duped union of
  `MODULES.flatMap(m => m.permissions)`. The one derived source.
- `buildAdaptiveClaims(perms: Set<string>): { can: Record<string, Record<string, boolean>> }`
  — pure. Splits each catalog permission on its first `.` and sets
  `can[module][action] = hasPermission(perms, permission)`. No I/O.
- `buildAdaptiveSchema(): object` — pure. Emits the GitBook JSON Schema (nested objects of
  `{ type: "boolean" }` leaves with one-line descriptions) from the same catalog. Top
  level permissive (`additionalProperties` not set to false) so standard
  `name`/`email`/`iat`/`exp` claims are not rejected.
- **Dependencies:** `MODULES` (`@/platform/modules/registry`), `hasPermission`
  (`@/platform/rbac/engine`). Both platform→platform (allowed).

### `src/app/api/gitbook/auth/route.ts` (modified)
- After resolving `person`, call `getEffectivePermissions(person.id)` and spread
  `buildAdaptiveClaims(perms)` into the signed claims object next to `name`/`email`/`iat`/`exp`.
- Everything else (redirect handling, `resolveTarget`, audit) unchanged. Emitting extra
  claims is inert while Adaptive content is off — GitBook ignores unreferenced claims —
  so this is safe to ship and deploy before any GitBook change.

## GitBook artifacts (repo-committed, applied on GitBook)

### `docs/gitbook/adaptive-schema.json` (new)
The exact JSON Schema pushed to the site via `updateSiteAdaptiveSchema`. Generated by
`buildAdaptiveSchema()` and committed for review + audit trail. A drift-guard test asserts
the committed file equals `buildAdaptiveSchema()` output, so adding a permission to a
module fails CI until the schema is regenerated.

### `docs/gitbook/adaptive-mapping.md` (new)
A table: each gated doc section/page → its GitBook condition expression, e.g.

| Docs location | Condition |
| --- | --- |
| Recruitment (section) | `visitor.claims.can.recruitment.access == true` |
| Recruitment → Review submissions | `visitor.claims.can.recruitment.review_all == true` |
| Learning → Manage courses | `visitor.claims.can.learning.manage_courses == true` |
| Admin (section) | `visitor.claims.can.admin.access == true` |
| … | … |

Open-to-all areas (My Info, "Report a concern", "Submit a request", Getting Started) get
**no** condition. Derived from `MODULES` + the known doc section/sub-page structure. The
user pastes these into the GitBook editor's condition fields.

## Testing

`src/platform/gitbook/adaptive-claims.test.ts` (pure, no DB):
- Admin `*` → every catalog leaf `true`.
- A `schedule.view`-only set → `can.schedule.view === true`, all sibling/other leaves `false`.
- Empty set → every leaf `false`.
- **Catalog completeness:** every `MODULES[].permissions` entry appears as exactly one
  `can[module][action]` leaf, and no extra leaves exist — guards against a new permission
  silently missing from docs gating.
- **Schema drift guard:** committed `docs/gitbook/adaptive-schema.json` deep-equals
  `buildAdaptiveSchema()`; schema leaf paths match the claim leaf paths.

Run with the safe per-worktree local Postgres (`TEST_DATABASE_URL=…`) per project
convention, though these tests touch no DB.

## Rollout / enablement (order)

1. Ship the code (JWT enrichment) — inert until GitBook is configured.
2. Push `adaptive-schema.json` to the site via `updateSiteAdaptiveSchema` (MCP).
3. User enables **Adaptive content** in GitBook site settings.
4. **Verify the signing key:** confirm the Adaptive-content visitor-token signing key
   equals the current `GITBOOK_JWT_KEY`. If GitBook issues a distinct key, update the env
   var (`GITBOOK_JWT_KEY`) — no code change. Docs auth breaks loudly if the key mismatches,
   so this is caught immediately.
5. User applies per-page conditions from `adaptive-mapping.md` in the GitBook editor.

## Risks

- **Signing-key mismatch** (see step 4) — verified at enablement, not a code risk.
- **Schema `additionalProperties`** — if GitBook rejects undeclared standard claims, add
  `name`/`email`/`iat`/`exp` to the schema. Verified when pushing the schema.
- **Dotted-key confusion** — avoided by the nested shape (no dotted keys anywhere).

## Non-goals

- No change to how permissions are computed or granted.
- No change to the login gate itself (docs remain fully authenticated).
- Applicant-facing docs and any section without a clear permission mapping stay
  always-visible (no condition).
- Not automating per-page condition application (no clean bulk API; done in the editor).
