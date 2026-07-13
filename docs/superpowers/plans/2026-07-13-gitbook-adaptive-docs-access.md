# GitBook Adaptive Docs Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the GitBook visitor-auth JWT with a permission-derived `can` claim so docs.havenfreeclinic.org shows each signed-in person only the docs for features they can use.

**Architecture:** A pure catalog + claim-builder derives, from the module registry, a nested `can` object of booleans (module → action → granted). The existing `/api/gitbook/auth` route computes the person's effective permissions and spreads `buildAdaptiveClaims(perms)` into the signed JWT. A matching JSON-Schema artifact is committed and pushed to GitBook via MCP; a page→condition mapping table guides manual condition setup. The code is inert until Adaptive content is enabled on the GitBook site.

**Tech Stack:** TypeScript, Next.js App Router (Node runtime route handler), Vitest, `tsx` for the schema-generator script, GitBook MCP for the live-site schema push.

## Global Constraints

- Permission catalog's single source of truth is `MODULES[].permissions` in `src/platform/modules/registry.ts`. Never hardcode a second copy.
- The `*` wildcard rule lives only in `hasPermission(perms, permission)` (`src/platform/rbac/engine.ts`). Always route grant checks through it so Platform Admin (`*`) resolves to every leaf `true`.
- Claim shape is a **nested** object of booleans keyed `can.<module>.<action>` (dot access, no dotted keys, no arrays).
- No prose em-dashes in committed docs/comments (project style).
- Path alias: `@/*` → `./src/*`. Tests: `import { describe, it, expect } from "vitest"`, colocated `*.test.ts`.
- Tests run via `npx vitest run <file>`; `vitest.setup.ts` supplies safe DB env (defaults to local `:5434`, never Neon). All tests in this plan are DB-free (pure functions, or the route test fully mocks its dependencies).
- Emitting the extra claim must stay inert while Adaptive content is off. Do not gate on any new env var; do not change redirect/login behavior.

---

## File Structure

- `src/platform/gitbook/catalog.ts` (new): registry-derived permission catalog, the `buildNested` helper, and `buildAdaptiveSchema()`. Imports only the registry (no RBAC engine, no DB), so the schema generator stays lean.
- `src/platform/gitbook/catalog.test.ts` (new): catalog completeness + schema shape.
- `src/platform/gitbook/adaptive-claims.ts` (new): `buildAdaptiveClaims(perms)`. Imports `buildNested` + `hasPermission`.
- `src/platform/gitbook/adaptive-claims.test.ts` (new): claim-builder behavior.
- `scripts/gen-gitbook-adaptive-schema.ts` (new): writes `docs/gitbook/adaptive-schema.json` from `buildAdaptiveSchema()`.
- `docs/gitbook/adaptive-schema.json` (new, generated): the JSON Schema pushed to GitBook.
- `src/platform/gitbook/schema-artifact.test.ts` (new): drift guard asserting the committed JSON equals `buildAdaptiveSchema()`. (Lives under `src/**` because vitest's `include` only picks up tests there.)
- `src/app/api/gitbook/auth/route.ts` (modify): compute perms, spread `buildAdaptiveClaims`.
- `src/app/api/gitbook/auth/route.test.ts` (new): asserts the signed JWT carries the `can` claim.
- `docs/gitbook/adaptive-mapping.md` (new): page → condition mapping for manual GitBook setup.

---

## Task 1: Permission catalog + adaptive schema builder

**Files:**
- Create: `src/platform/gitbook/catalog.ts`
- Test: `src/platform/gitbook/catalog.test.ts`

**Interfaces:**
- Consumes: `MODULES` from `@/platform/modules/registry` (each has `permissions: string[]`).
- Produces:
  - `ADAPTIVE_PERMISSION_CATALOG: string[]`: sorted, de-duped union of all `MODULES[].permissions`.
  - `buildNested<T>(leaf: (permission: string) => T): Record<string, Record<string, T>>`: for each catalog permission, split on the first `.` into `[module, action]` and set `result[module][action] = leaf(permission)`.
  - `buildAdaptiveSchema(): { type: "object"; properties: { can: unknown } }`: the GitBook visitor-claims JSON Schema.

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/gitbook/catalog.test.ts
import { describe, it, expect } from "vitest";
import { MODULES } from "@/platform/modules/registry";
import { ADAPTIVE_PERMISSION_CATALOG, buildNested, buildAdaptiveSchema } from "./catalog";

describe("ADAPTIVE_PERMISSION_CATALOG", () => {
  it("is the sorted, de-duped union of every module's permissions", () => {
    const expected = [...new Set(MODULES.flatMap((m) => m.permissions))].sort();
    expect(ADAPTIVE_PERMISSION_CATALOG).toEqual(expected);
  });

  it("every entry is a single-dot namespace.action string", () => {
    for (const p of ADAPTIVE_PERMISSION_CATALOG) {
      expect(p.split(".").length).toBe(2);
    }
  });
});

describe("buildNested", () => {
  it("groups each permission under module -> action", () => {
    const nested = buildNested(() => true);
    // schedule.view and schedule.edit_all both live under `schedule`
    expect(nested.schedule.view).toBe(true);
    expect(nested.schedule.edit_all).toBe(true);
    expect(nested.learning.manage_courses).toBe(true);
  });

  it("covers exactly the catalog (no missing or extra leaves)", () => {
    const leaves: string[] = [];
    const nested = buildNested((p) => p);
    for (const mod of Object.keys(nested)) {
      for (const action of Object.keys(nested[mod])) leaves.push(`${mod}.${action}`);
    }
    expect(leaves.sort()).toEqual([...ADAPTIVE_PERMISSION_CATALOG].sort());
  });
});

describe("buildAdaptiveSchema", () => {
  it("emits a top-level object with a `can` property of nested boolean leaves", () => {
    const schema = buildAdaptiveSchema();
    expect(schema.type).toBe("object");
    const can = schema.properties.can as {
      type: string;
      properties: Record<string, { properties: Record<string, { type: string }> }>;
    };
    expect(can.type).toBe("object");
    expect(can.properties.schedule.properties.view.type).toBe("boolean");
    expect(can.properties.admin.properties.access.type).toBe("boolean");
  });

  it("does not forbid additional top-level claims (name/email/iat/exp survive)", () => {
    const schema = buildAdaptiveSchema() as { additionalProperties?: boolean };
    // omitted or true — never false, or GitBook would reject standard JWT claims
    expect(schema.additionalProperties).not.toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/gitbook/catalog.test.ts`
Expected: FAIL, cannot resolve `./catalog`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/platform/gitbook/catalog.ts
import { MODULES } from "@/platform/modules/registry";

/**
 * Single source of truth for the permission strings exposed to GitBook adaptive
 * content: the sorted, de-duped union of every module's declared permissions.
 * Derived from MODULES so it can never drift from the RBAC editor.
 */
export const ADAPTIVE_PERMISSION_CATALOG: string[] = [
  ...new Set(MODULES.flatMap((m) => m.permissions)),
].sort();

/** Split "learning.manage_courses" into ["learning", "manage_courses"] on the first dot. */
function splitPermission(permission: string): [string, string] {
  const dot = permission.indexOf(".");
  return [permission.slice(0, dot), permission.slice(dot + 1)];
}

/**
 * Build the nested module -> action shape used by both the visitor-claims schema
 * and the signed `can` claim, mapping each catalog permission to a leaf value.
 */
export function buildNested<T>(leaf: (permission: string) => T): Record<string, Record<string, T>> {
  const out: Record<string, Record<string, T>> = {};
  for (const permission of ADAPTIVE_PERMISSION_CATALOG) {
    const [mod, action] = splitPermission(permission);
    (out[mod] ??= {})[action] = leaf(permission);
  }
  return out;
}

/**
 * The GitBook adaptive-content visitor-claims JSON Schema. Describes only our
 * custom `can` object; the top level stays permissive (additionalProperties not
 * set to false) so GitBook does not reject the standard name/email/iat/exp claims.
 */
export function buildAdaptiveSchema() {
  const canProperties = buildNested((permission) => ({
    type: "boolean" as const,
    description: `Whether the visitor holds the ${permission} permission in HAVEN Hub.`,
  }));
  const properties: Record<string, unknown> = {};
  for (const [mod, actions] of Object.entries(canProperties)) {
    properties[mod] = { type: "object", properties: actions, additionalProperties: false };
  }
  return {
    type: "object" as const,
    properties: {
      can: { type: "object", properties, additionalProperties: false },
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/gitbook/catalog.test.ts`
Expected: PASS (all 6 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/platform/gitbook/catalog.ts src/platform/gitbook/catalog.test.ts
git commit -m "feat(gitbook): registry-derived permission catalog + adaptive schema builder"
```

---

## Task 2: Adaptive claim builder

**Files:**
- Create: `src/platform/gitbook/adaptive-claims.ts`
- Test: `src/platform/gitbook/adaptive-claims.test.ts`

**Interfaces:**
- Consumes: `buildNested` + `ADAPTIVE_PERMISSION_CATALOG` from `./catalog`; `hasPermission` from `@/platform/rbac/engine`.
- Produces: `buildAdaptiveClaims(perms: Set<string>): { can: Record<string, Record<string, boolean>> }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/gitbook/adaptive-claims.test.ts
import { describe, it, expect } from "vitest";
import { ADAPTIVE_PERMISSION_CATALOG } from "./catalog";
import { buildAdaptiveClaims } from "./adaptive-claims";

describe("buildAdaptiveClaims", () => {
  it("wildcard '*' grants every leaf", () => {
    const { can } = buildAdaptiveClaims(new Set(["*"]));
    for (const mod of Object.values(can)) {
      for (const granted of Object.values(mod)) expect(granted).toBe(true);
    }
  });

  it("grants only the held permission and nothing else", () => {
    const { can } = buildAdaptiveClaims(new Set(["schedule.view"]));
    expect(can.schedule.view).toBe(true);
    expect(can.schedule.edit_all).toBe(false);
    expect(can.admin.access).toBe(false);
    expect(can.learning.manage_courses).toBe(false);
  });

  it("empty permission set grants nothing", () => {
    const { can } = buildAdaptiveClaims(new Set());
    for (const mod of Object.values(can)) {
      for (const granted of Object.values(mod)) expect(granted).toBe(false);
    }
  });

  it("emits exactly one boolean leaf per catalog permission", () => {
    const { can } = buildAdaptiveClaims(new Set());
    const leaves: string[] = [];
    for (const mod of Object.keys(can)) {
      for (const action of Object.keys(can[mod])) leaves.push(`${mod}.${action}`);
    }
    expect(leaves.sort()).toEqual([...ADAPTIVE_PERMISSION_CATALOG].sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/gitbook/adaptive-claims.test.ts`
Expected: FAIL, cannot resolve `./adaptive-claims`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/platform/gitbook/adaptive-claims.ts
import { hasPermission } from "@/platform/rbac/engine";
import { buildNested } from "./catalog";

/**
 * Turn an effective-permission set into the nested `can` claim GitBook adaptive
 * content reads (e.g. visitor.claims.can.learning.manage_courses). Routes every
 * check through hasPermission, so a person holding "*" gets every leaf true.
 */
export function buildAdaptiveClaims(perms: Set<string>): {
  can: Record<string, Record<string, boolean>>;
} {
  return { can: buildNested((permission) => hasPermission(perms, permission)) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/gitbook/adaptive-claims.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/gitbook/adaptive-claims.ts src/platform/gitbook/adaptive-claims.test.ts
git commit -m "feat(gitbook): buildAdaptiveClaims maps permissions to nested can claim"
```

---

## Task 3: Committed schema artifact + generator + drift guard

**Files:**
- Create: `scripts/gen-gitbook-adaptive-schema.ts`
- Create: `docs/gitbook/adaptive-schema.json` (generated)
- Test: `src/platform/gitbook/schema-artifact.test.ts`

**Interfaces:**
- Consumes: `buildAdaptiveSchema` from `@/platform/gitbook/catalog`.
- Produces: the committed `docs/gitbook/adaptive-schema.json` file (the exact payload pushed to GitBook in Task 6).

- [ ] **Step 1: Write the generator script**

```ts
// scripts/gen-gitbook-adaptive-schema.ts
// Regenerate the committed GitBook adaptive-content schema:
//   npx tsx scripts/gen-gitbook-adaptive-schema.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildAdaptiveSchema } from "../src/platform/gitbook/catalog";

const out = resolve(__dirname, "../docs/gitbook/adaptive-schema.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(buildAdaptiveSchema(), null, 2) + "\n");
console.log(`wrote ${out}`);
```

- [ ] **Step 2: Generate the artifact**

Run: `npx tsx scripts/gen-gitbook-adaptive-schema.ts`
Expected: prints `wrote .../docs/gitbook/adaptive-schema.json`; the file now contains a top-level `{ "type": "object", "properties": { "can": { … } } }` with a boolean leaf per permission.

- [ ] **Step 3: Write the failing drift-guard test**

```ts
// src/platform/gitbook/schema-artifact.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildAdaptiveSchema } from "./catalog";

describe("committed adaptive-schema.json", () => {
  it("matches buildAdaptiveSchema() (regenerate with scripts/gen-gitbook-adaptive-schema.ts)", () => {
    const path = resolve(process.cwd(), "docs/gitbook/adaptive-schema.json");
    const committed = JSON.parse(readFileSync(path, "utf8"));
    expect(committed).toEqual(buildAdaptiveSchema());
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/gitbook/schema-artifact.test.ts`
Expected: PASS. (If it fails with a mismatch, the artifact is stale, rerun the Step 2 generator.)

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-gitbook-adaptive-schema.ts docs/gitbook/adaptive-schema.json src/platform/gitbook/schema-artifact.test.ts
git commit -m "feat(gitbook): commit adaptive-content schema artifact + generator + drift guard"
```

---

## Task 4: Wire the `can` claim into the auth route

**Files:**
- Modify: `src/app/api/gitbook/auth/route.ts` (imports near top; token assembly at lines ~85-94)
- Test: `src/app/api/gitbook/auth/route.test.ts`

**Interfaces:**
- Consumes: `getEffectivePermissions` from `@/platform/rbac/engine`; `buildAdaptiveClaims` from `@/platform/gitbook/adaptive-claims`.
- Produces: no new exports; the signed JWT now carries `can`.

- [ ] **Step 1: Write the failing route test**

```ts
// src/app/api/gitbook/auth/route.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock every dependency so this test is DB-free and deterministic.
vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));
vi.mock("@/platform/rbac/engine", () => ({ getEffectivePermissions: vi.fn() }));
vi.mock("@/platform/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/platform/config", () => ({
  config: { GITBOOK_JWT_KEY: "test-key", GITBOOK_SITE_URL: "https://docs.example.org" },
}));

import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { getEffectivePermissions } from "@/platform/rbac/engine";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asMock = (f: unknown) => f as ReturnType<typeof vi.fn>;

function decodePayload(token: string): Record<string, any> {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString());
}

describe("GET /api/gitbook/auth adaptive claims", () => {
  beforeEach(() => vi.resetAllMocks());

  it("signs the person's `can` permissions into the returned jwt_token", async () => {
    asMock(auth).mockResolvedValue({ personId: "p1", user: { email: "j@x.com" } });
    asMock(getActivePerson).mockResolvedValue({ id: "p1", name: "Jo", contactEmail: "jo@x.com" });
    asMock(getEffectivePermissions).mockResolvedValue(new Set(["schedule.view"]));

    const { GET } = await import("./route");
    const req = new Request("https://hub.example.org/api/gitbook/auth?location=/schedule");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(req as any);

    const loc = res.headers.get("location");
    expect(loc).toBeTruthy();
    const token = new URL(loc as string).searchParams.get("jwt_token");
    expect(token).toBeTruthy();
    const payload = decodePayload(token as string);
    expect(payload.can.schedule.view).toBe(true);
    expect(payload.can.schedule.edit_all).toBe(false);
    expect(payload.can.admin.access).toBe(false);
    expect(payload.name).toBe("Jo");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/gitbook/auth/route.test.ts`
Expected: FAIL, `payload.can` is undefined (route does not emit it yet).

- [ ] **Step 3: Add the imports**

At the top of `src/app/api/gitbook/auth/route.ts`, after the existing `import { recordAudit } from "@/platform/audit";` line, add:

```ts
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { buildAdaptiveClaims } from "@/platform/gitbook/adaptive-claims";
```

- [ ] **Step 4: Spread the claim into the signed token**

Replace the token-assembly block (currently):

```ts
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt(
    {
      name: person.name,
      email: person.contactEmail ?? session.user?.email ?? undefined,
      iat: now,
      exp: now + 60 * 60, // 1 hour, matching GitBook's reference backend
    },
    GITBOOK_JWT_KEY
  );
```

with:

```ts
  // Effective permissions become a nested `can` claim GitBook adaptive content
  // reads (visitor.claims.can.<module>.<action>). Inert until Adaptive content
  // is enabled on the site: GitBook ignores claims no condition references.
  const perms = await getEffectivePermissions(person.id);
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt(
    {
      name: person.name,
      email: person.contactEmail ?? session.user?.email ?? undefined,
      iat: now,
      exp: now + 60 * 60, // 1 hour, matching GitBook's reference backend
      ...buildAdaptiveClaims(perms),
    },
    GITBOOK_JWT_KEY
  );
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/app/api/gitbook/auth/route.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck the whole change**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/gitbook/auth/route.ts src/app/api/gitbook/auth/route.test.ts
git commit -m "feat(gitbook): sign permission-derived can claim into visitor-auth JWT"
```

---

## Task 5: Page-to-condition mapping table

**Files:**
- Create: `docs/gitbook/adaptive-mapping.md`

**Interfaces:**
- Consumes (read-only): the live docs site structure via GitBook MCP; the module registry for module→permission mapping.
- Produces: a human-usable table the user pastes into the GitBook editor.

GitBook IDs (from project memory `gitbook-user-docs`): org `HpnZmQbk6bbOde4xMDwO`, site `site_kvUkR`, docs space `tHfYPT1JPCmq1ZcM0VKy`.

- [ ] **Step 1: Fetch the live docs structure**

Use the GitBook MCP:
1. `get_site_structure` for site `site_kvUkR` to list its sections/spaces.
2. Enumerate the docs space (`tHfYPT1JPCmq1ZcM0VKy`) page tree (the ~11 section landings and their child pages) via `get_site_structure` / `get_page` as needed to capture each page's title and id.

- [ ] **Step 2: Derive each page's condition**

Apply these rules (module → `can` path via `src/platform/modules/registry.ts`):

- **Section landing** → its module's `accessPermission`, as `visitor.claims.can.<module>.<action>`. E.g. Recruitment section → `visitor.claims.can.recruitment.access == true`; Admin → `visitor.claims.can.admin.access == true`; Learning → `visitor.claims.can.learning.access == true`; Clinic → `visitor.claims.can.clinic.access == true`; Schedule → `visitor.claims.can.schedule.view == true`; Volunteer Management → `visitor.claims.can.volunteers.view == true`.
- **Manager/admin sub-page** (mirrors a registry nav item that declares a `permission`) → that permission. E.g. Learning "Manage courses" → `visitor.claims.can.learning.manage_courses == true`; Learning "Completion" → `...learning.view_progress`; Volunteers "Master view"/"EHS training" → `...volunteers.manage_compliance`; Volunteers "Spanish review" → `...volunteers.verify_spanish`; Volunteers "Offboarding" page → `...volunteers.manage_offboarding`; Incidents "Review" → `...incidents.manage`; Incidents "Strikes" → `...incidents.view_strikes`; Support "All requests"/"Epic / YNHH tools" → `...support.manage_requests`; each Admin sub-page → its `admin.*` permission per the registry nav.
- **Open sections / general pages** (My Info; "Report a concern"; "Submit a request"/"My requests"; Getting Started; any applicant-facing or overview page with no gating screen) → **no condition** (always visible).

- [ ] **Step 3: Write the mapping file**

Write `docs/gitbook/adaptive-mapping.md` with a short intro (how to apply a condition in the GitBook editor: page/section actions menu → "Add condition" → paste the expression), then a table with columns: `Section` | `Page` | `GitBook page id` | `Condition` (or `none`). One row per section landing and per child page discovered in Step 1. Add a final "Always visible (no condition)" list for the open pages.

- [ ] **Step 4: Sanity-check the conditions against the schema**

Every `visitor.claims.can.<module>.<action>` used in the table must correspond to a leaf in `docs/gitbook/adaptive-schema.json`. Spot-check each distinct condition path exists there.

- [ ] **Step 5: Commit**

```bash
git add docs/gitbook/adaptive-mapping.md
git commit -m "docs(gitbook): page-to-condition mapping for adaptive docs access"
```

---

## Task 6: Push the schema to GitBook + enablement handoff

**Files:** none (live-site operation + user handoff).

This task mutates the live GitBook site and coordinates with the user. Adaptive content must be **enabled** on the site before the schema endpoint accepts a write, and enabling it is where the user confirms the signing key.

- [ ] **Step 1: Confirm prerequisite with the user**

Ask the user to enable **Adaptive content** in GitBook site settings for `site_kvUkR`, and to confirm the generated visitor-token **signing key equals the current `GITBOOK_JWT_KEY`** env value. If GitBook shows a different key, the user updates the `GITBOOK_JWT_KEY` env var (Vercel + local), no code change. Do not proceed until confirmed.

- [ ] **Step 2: Push the schema via MCP**

Use GitBook MCP `updateSiteAdaptiveSchema` for org `HpnZmQbk6bbOde4xMDwO`, site `site_kvUkR`, with the exact contents of `docs/gitbook/adaptive-schema.json` as the visitor-attributes schema. (Discover exact params first with `describe_operation("updateSiteAdaptiveSchema")`.)

- [ ] **Step 3: Verify**

Call `getSiteAdaptiveSchema` for the same org/site and confirm it deep-equals `docs/gitbook/adaptive-schema.json`.

- [ ] **Step 4: Hand off conditions to the user**

Point the user at `docs/gitbook/adaptive-mapping.md` and confirm the rollout: apply conditions per the table, then spot-check as two personas (e.g. a plain volunteer should not see the Admin or Recruitment sections; an admin sees everything).

---

## Self-Review

**1. Spec coverage:**
- Fine-grained per-permission claim → Tasks 1-2 (nested `can`, `*` expansion). ✓
- Nested-object shape / no dotted keys / no arrays → Task 1 `buildNested`, Global Constraints. ✓
- Catalog from `MODULES[].permissions` (no drift) → Task 1 + completeness tests. ✓
- Route enrichment, inert until enabled → Task 4 (+ comment). ✓
- Schema artifact pushed via MCP → Tasks 3 (artifact) + 6 (push). ✓
- Mapping table deliverable → Task 5. ✓
- Signing-key verification + failure-mode (propagate) → Task 6 Step 1; propagate is the default (no try/catch added). ✓
- Testing: builder behavior, catalog completeness, schema drift, route claim → Tasks 1-4. ✓

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". The only live-data-dependent content (Task 5 page list) is produced by an explicit MCP-fetch procedure with concrete derivation rules and worked examples, not a placeholder.

**3. Type consistency:** `buildNested<T>` returns `Record<string, Record<string, T>>`; `buildAdaptiveClaims` returns `{ can: Record<string, Record<string, boolean>> }` using it with `T = boolean`; `buildAdaptiveSchema` uses it with an object leaf. `ADAPTIVE_PERMISSION_CATALOG`, `hasPermission(perms, permission)`, and `getEffectivePermissions(person.id)` signatures match their sources. Route consumes `buildAdaptiveClaims(perms: Set<string>)`, matches Task 2. Consistent.
