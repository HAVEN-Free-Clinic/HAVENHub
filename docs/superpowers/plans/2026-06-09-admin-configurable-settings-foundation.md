# Admin-Configurable Settings — Phase 0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the DB-backed settings store, typed registry, async resolver, and admin Settings page that let a non-developer change app behavior through the UI, proven end-to-end with one canary setting.

**Architecture:** A `Setting` table stores only overrides. A code registry declares each editable setting once (key, Zod schema, env default, render hints). An async resolver returns DB-override → env-default with a 30s in-memory cache. The admin Settings page auto-renders typed forms from the registry; saves validate against the registry schema, write the override, and audit the change.

**Tech Stack:** Next.js 16 App Router (server components + server actions), Prisma/PostgreSQL, Zod, Vitest. Existing helpers: `prisma` (`@/platform/db`), `recordAudit` (`@/platform/audit`), `requirePermission` (`@/platform/auth/session`), `config` (`@/platform/config`), `resetDb` (`@/platform/test/db`).

**Spec:** `docs/superpowers/specs/2026-06-09-admin-configurable-settings-foundation-design.md`

---

## File Structure

- Create `src/platform/settings/registry.ts` — setting definitions + `getSettingDef`. One responsibility: declare what is configurable.
- Create `src/platform/settings/registry.test.ts` — registry invariants.
- Create `src/platform/settings/service.ts` — resolver, cache, `setSetting`/`resetSetting`, `SettingValidationError`. One responsibility: read/write resolved values.
- Create `src/platform/settings/service.test.ts` — resolution, cache, validation, audit.
- Create `src/app/admin/settings/page.tsx` — Settings hub: auto-rendered forms + inline server actions.
- Modify `prisma/schema.prisma` — add `Setting` model.
- Modify `src/platform/modules/registry.ts` — add `admin.manage_settings` permission + Settings nav item.
- Modify `src/modules/schedule/services/builder.ts:965` — canary consumer reads from the resolver.

---

## Task 1: Add the `Setting` model + migration

**Files:**
- Modify: `prisma/schema.prisma` (append a new model)

- [ ] **Step 1: Add the model**

Append to `prisma/schema.prisma`:

```prisma
model Setting {
  key         String   @id
  value       Json
  updatedById String?
  updatedAt   DateTime @updatedAt
}
```

- [ ] **Step 2: Create and apply the migration**

Run: `npx prisma migrate dev --name add_setting_model`
Expected: migration created under `prisma/migrations/`, applied to the dev DB, and `prisma generate` runs (the `Setting` delegate becomes available on `prisma`).

- [ ] **Step 3: Apply the migration to the test database**

Run: `npm run test:prepare`
Expected: completes without error (test DB now has the `Setting` table).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(settings): add Setting model for admin-configurable overrides"
```

---

## Task 2: Settings registry with the canary entry

**Files:**
- Create: `src/platform/settings/registry.ts`
- Test: `src/platform/settings/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/platform/settings/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SETTINGS, getSettingDef } from "./registry";

describe("settings registry", () => {
  it("has unique keys", () => {
    const keys = SETTINGS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every envDefault satisfies its own schema", () => {
    for (const def of SETTINGS) {
      const result = def.schema.safeParse(def.envDefault());
      expect(result.success, `${def.key} default invalid`).toBe(true);
    }
  });

  it("never registers a secret setting", () => {
    for (const def of SETTINGS) {
      expect(def.secret).toBe(false);
    }
  });

  it("registers the rhd.maxProcedures canary", () => {
    const def = getSettingDef("rhd.maxProcedures");
    expect(def.category).toBe("Operations");
  });

  it("throws for an unregistered key", () => {
    expect(() => getSettingDef("nope.missing")).toThrowError(/Unregistered/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/settings/registry.test.ts`
Expected: FAIL — cannot resolve `./registry`.

- [ ] **Step 3: Write the registry**

Create `src/platform/settings/registry.ts`:

```ts
import { z } from "zod";
import { config } from "@/platform/config";

export type SettingInput =
  | { type: "number"; min?: number; max?: number }
  | { type: "text" }
  | { type: "textarea" }
  | { type: "boolean" }
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
  /** Always false — secrets are never registered. */
  secret: false;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/settings/registry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/settings/registry.ts src/platform/settings/registry.test.ts
git commit -m "feat(settings): registry of admin-editable settings with rhd.maxProcedures canary"
```

---

## Task 3: Resolver service

**Files:**
- Create: `src/platform/settings/service.ts`
- Test: `src/platform/settings/service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/platform/settings/service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  getSetting,
  getCategory,
  setSetting,
  resetSetting,
  SettingValidationError,
  _resetSettingsCache,
} from "./service";

beforeEach(async () => {
  await resetDb();
  _resetSettingsCache();
});

describe("getSetting", () => {
  it("returns the env default when no override row exists", async () => {
    // config.RHD_MAX_PROCEDURES defaults to 3 in the test env.
    expect(await getSetting<number>("rhd.maxProcedures")).toBe(3);
  });

  it("returns the stored override when present and valid", async () => {
    await prisma.setting.create({ data: { key: "rhd.maxProcedures", value: 5 } });
    expect(await getSetting<number>("rhd.maxProcedures")).toBe(5);
  });

  it("falls back to the env default when the stored value is invalid", async () => {
    await prisma.setting.create({ data: { key: "rhd.maxProcedures", value: "garbage" } });
    expect(await getSetting<number>("rhd.maxProcedures")).toBe(3);
  });

  it("throws for an unregistered key", async () => {
    await expect(getSetting("nope.missing")).rejects.toThrow(/Unregistered/);
  });

  it("serves the second read within the TTL from cache (no DB hit)", async () => {
    await getSetting("rhd.maxProcedures"); // warms the cache
    const spy = vi.spyOn(prisma.setting, "findUnique");
    await getSetting("rhd.maxProcedures");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("getCategory", () => {
  it("returns resolved values and an isOverridden flag", async () => {
    const before = await getCategory("Operations");
    expect(before).toEqual([
      expect.objectContaining({ key: "rhd.maxProcedures", value: 3, isOverridden: false }),
    ]);

    await setSetting("rhd.maxProcedures", 7, null);
    _resetSettingsCache();
    const after = await getCategory("Operations");
    expect(after[0]).toMatchObject({ value: 7, isOverridden: true });
  });
});

describe("setSetting", () => {
  it("rejects a value that fails the schema", async () => {
    await expect(setSetting("rhd.maxProcedures", -1, null)).rejects.toBeInstanceOf(
      SettingValidationError
    );
    expect(await prisma.setting.findUnique({ where: { key: "rhd.maxProcedures" } })).toBeNull();
  });

  it("writes the override and an audit row", async () => {
    await setSetting("rhd.maxProcedures", 9, "person-1");
    const row = await prisma.setting.findUnique({ where: { key: "rhd.maxProcedures" } });
    expect(row).toMatchObject({ value: 9, updatedById: "person-1" });

    const audit = await prisma.auditLog.findFirst({ where: { action: "setting.update" } });
    expect(audit).toMatchObject({
      entityType: "Setting",
      entityId: "rhd.maxProcedures",
      before: 3,
      after: 9,
      actorPersonId: "person-1",
    });
  });
});

describe("resetSetting", () => {
  it("deletes the override and audits the reset", async () => {
    await setSetting("rhd.maxProcedures", 9, "person-1");
    await resetSetting("rhd.maxProcedures", "person-1");
    expect(await prisma.setting.findUnique({ where: { key: "rhd.maxProcedures" } })).toBeNull();
    expect(await getSetting<number>("rhd.maxProcedures")).toBe(3);

    const audit = await prisma.auditLog.findFirst({ where: { action: "setting.reset" } });
    expect(audit).toMatchObject({ entityId: "rhd.maxProcedures", before: 9, after: 3 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/settings/service.test.ts`
Expected: FAIL — cannot resolve `./service`.

- [ ] **Step 3: Write the service**

Create `src/platform/settings/service.ts`:

```ts
import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { SETTINGS, getSettingDef, type SettingInput } from "./registry";

const TTL_MS = 30_000;

type CacheEntry = { value: unknown; expiresAt: number };
const cache = new Map<string, CacheEntry>();

/** Test-only: clear the in-memory cache between cases. */
export function _resetSettingsCache(): void {
  cache.clear();
}

/** Thrown when a submitted value fails its registry schema. */
export class SettingValidationError extends Error {
  constructor(
    public readonly key: string,
    message: string
  ) {
    super(message);
    this.name = "SettingValidationError";
  }
}

/**
 * Resolve a setting: validated DB override → env default. An invalid stored
 * value logs a warning and falls back to the default; it never throws to the
 * caller. An unregistered key throws (programmer error).
 */
export async function getSetting<T = unknown>(key: string): Promise<T> {
  const def = getSettingDef(key);

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;

  const row = await prisma.setting.findUnique({ where: { key } });
  let value: unknown;
  if (row) {
    const parsed = def.schema.safeParse(row.value);
    if (parsed.success) {
      value = parsed.data;
    } else {
      console.warn(
        `[settings] invalid stored value for "${key}"; using default`,
        parsed.error.issues
      );
      value = def.envDefault();
    }
  } else {
    value = def.envDefault();
  }

  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  return value as T;
}

export type ResolvedSetting = {
  key: string;
  category: string;
  label: string;
  help: string;
  input: SettingInput;
  value: unknown;
  isOverridden: boolean;
};

/** Resolve every setting in a category for rendering a form group. */
export async function getCategory(category: string): Promise<ResolvedSetting[]> {
  const defs = SETTINGS.filter((d) => d.category === category);
  const rows = await prisma.setting.findMany({
    where: { key: { in: defs.map((d) => d.key) } },
  });
  const overrides = new Map(rows.map((r) => [r.key, r.value]));

  return defs.map((def) => {
    const hasOverride = overrides.has(def.key);
    let value = def.envDefault();
    if (hasOverride) {
      const parsed = def.schema.safeParse(overrides.get(def.key));
      if (parsed.success) value = parsed.data;
    }
    return {
      key: def.key,
      category: def.category,
      label: def.label,
      help: def.help,
      input: def.input,
      value,
      isOverridden: hasOverride,
    };
  });
}

/** Validate, persist an override, invalidate cache, and audit. */
export async function setSetting(
  key: string,
  rawValue: unknown,
  actorPersonId: string | null
): Promise<void> {
  const def = getSettingDef(key);
  const parsed = def.schema.safeParse(rawValue);
  if (!parsed.success) {
    throw new SettingValidationError(
      key,
      parsed.error.issues.map((i) => i.message).join("; ")
    );
  }

  const before = await getSetting(key);
  const value = parsed.data as Prisma.InputJsonValue;

  await prisma.setting.upsert({
    where: { key },
    update: { value, updatedById: actorPersonId },
    create: { key, value, updatedById: actorPersonId },
  });
  cache.delete(key);

  await recordAudit({
    actorPersonId,
    action: "setting.update",
    entityType: "Setting",
    entityId: key,
    before: before as Prisma.InputJsonValue,
    after: value,
  });
}

/** Remove an override so the value falls back to the env default; audit it. */
export async function resetSetting(
  key: string,
  actorPersonId: string | null
): Promise<void> {
  const def = getSettingDef(key);
  const before = await getSetting(key);

  await prisma.setting.deleteMany({ where: { key } });
  cache.delete(key);

  await recordAudit({
    actorPersonId,
    action: "setting.reset",
    entityType: "Setting",
    entityId: key,
    before: before as Prisma.InputJsonValue,
    after: def.envDefault() as Prisma.InputJsonValue,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/settings/service.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/platform/settings/service.ts src/platform/settings/service.test.ts
git commit -m "feat(settings): resolver service with cache, validation, and audit"
```

---

## Task 4: Wire the canary consumer

**Files:**
- Modify: `src/modules/schedule/services/builder.ts:965` (inside the async `buildRhdBlock`)

- [ ] **Step 1: Add the import**

At the top of `src/modules/schedule/services/builder.ts`, add alongside the existing imports:

```ts
import { getSetting } from "@/platform/settings/service";
```

- [ ] **Step 2: Replace the hardcoded read**

In `buildRhdBlock`, change the `computeClinicReadiness({ ... })` call so this line:

```ts
    maxProceduresPerClinic: config.RHD_MAX_PROCEDURES,
```

becomes:

```ts
    maxProceduresPerClinic: await getSetting<number>("rhd.maxProcedures"),
```

(`buildRhdBlock` is already `async`, so `await` is valid here.)

**Important:** line 965 was the *only* `config.` reference in `builder.ts`, so the
existing `import { config } from "@/platform/config";` is now unused. Remove that
import line, or `npm run lint` will fail on `no-unused-vars`.

- [ ] **Step 3: Verify types and that nothing regressed**

Run: `npm run typecheck`
Expected: PASS (no type errors).

Run: `npx vitest run src/modules/schedule`
Expected: PASS (existing schedule/builder tests still green).

- [ ] **Step 4: Commit**

```bash
git add src/modules/schedule/services/builder.ts
git commit -m "feat(settings): read rhd.maxProcedures from the settings resolver"
```

---

## Task 5: Register the permission and nav item

**Files:**
- Modify: `src/platform/modules/registry.ts` (the `admin` manifest entry)

- [ ] **Step 1: Add the permission**

In the `admin` manifest's `permissions` array, add `"admin.manage_settings"`:

```ts
    permissions: [
      "admin.access",
      "admin.manage_people",
      "admin.manage_terms",
      "admin.manage_roles",
      "admin.view_audit",
      "admin.manage_sync",
      "admin.manage_email_templates",
      "admin.send_email_campaign",
      "admin.manage_settings",
    ],
```

- [ ] **Step 2: Add the nav item**

In the same `admin` manifest's `nav` array, add a Settings entry after `Email`:

```ts
      { label: "Settings", href: "/admin/settings" },
```

- [ ] **Step 3: Verify the registry tests still pass**

Run: `npx vitest run src/platform/modules`
Expected: PASS — the new permission is namespaced by `admin.` (satisfies the namespacing test); module-id tests are unaffected.

- [ ] **Step 4: Commit**

```bash
git add src/platform/modules/registry.ts
git commit -m "feat(settings): register admin.manage_settings permission and Settings nav"
```

---

## Task 6: Admin Settings page with auto-rendered forms

**Files:**
- Create: `src/app/admin/settings/page.tsx`

This page is a server component. It gates on `admin.manage_settings`, renders one
form per field (each form carries the field's key), and defines two inline server
actions (`updateAction`, `resetAction`) that coerce the submitted string to the
field's type, call the service, and revalidate.

- [ ] **Step 1: Write the page**

Create `src/app/admin/settings/page.tsx`:

```tsx
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { buttonClasses } from "@/platform/ui/button";
import { listCategories } from "@/platform/settings/registry";
import {
  getCategory,
  setSetting,
  resetSetting,
  SettingValidationError,
  type ResolvedSetting,
} from "@/platform/settings/service";

const PERMISSION = "admin.manage_settings";

/** Coerce a submitted form string to the value the setting's schema expects. */
function coerce(input: ResolvedSetting["input"], raw: FormDataEntryValue | null): unknown {
  switch (input.type) {
    case "number":
      return raw === null || raw === "" ? NaN : Number(raw);
    case "boolean":
      return raw === "on" || raw === "true";
    default:
      return typeof raw === "string" ? raw : "";
  }
}

type PageProps = { searchParams: Promise<{ error?: string; saved?: string }> };

export default async function SettingsPage({ searchParams }: PageProps) {
  await requirePermission(PERMISSION);
  const { error, saved } = await searchParams;

  async function updateAction(formData: FormData) {
    "use server";
    const session = await requirePermission(PERMISSION);
    const key = String(formData.get("__key"));
    const groups = await Promise.all(listCategories().map((c) => getCategory(c)));
    const def = groups.flat().find((s) => s.key === key);
    if (!def) redirect(`/admin/settings?error=${encodeURIComponent("Unknown setting")}`);

    const value = coerce(def.input, formData.get(key));
    try {
      await setSetting(key, value, session.personId);
    } catch (err) {
      if (err instanceof SettingValidationError) {
        redirect(`/admin/settings?error=${encodeURIComponent(`${def.label}: ${err.message}`)}`);
      }
      throw err;
    }
    revalidatePath("/admin/settings");
    redirect("/admin/settings?saved=1");
  }

  async function resetAction(formData: FormData) {
    "use server";
    const session = await requirePermission(PERMISSION);
    const key = String(formData.get("__key"));
    await resetSetting(key, session.personId);
    revalidatePath("/admin/settings");
    redirect("/admin/settings?saved=1");
  }

  const categories = listCategories();
  const groups = await Promise.all(
    categories.map(async (category) => ({ category, settings: await getCategory(category) }))
  );

  return (
    <div className="space-y-8">
      <PageHeader
        title="Settings"
        description="Configure app behavior without redeploying. Changes are audited."
      />

      {error && (
        <p className="rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      )}
      {saved && !error && (
        <p className="rounded-md bg-green-50 px-4 py-2 text-sm text-green-700">Saved.</p>
      )}

      {groups.map(({ category, settings }) => (
        <section key={category} className="space-y-4">
          <h2 className="text-lg font-semibold">{category}</h2>
          <div className="space-y-6">
            {settings.map((s) => (
              <div key={s.key} className="rounded-lg border border-gray-200 p-4">
                <form action={updateAction} className="space-y-2">
                  <input type="hidden" name="__key" value={s.key} />
                  <label htmlFor={s.key} className="block text-sm font-medium">
                    {s.label}
                  </label>
                  <p className="text-xs text-gray-500">{s.help}</p>
                  {s.input.type === "boolean" ? (
                    <input
                      id={s.key}
                      name={s.key}
                      type="checkbox"
                      defaultChecked={Boolean(s.value)}
                    />
                  ) : s.input.type === "select" ? (
                    <select id={s.key} name={s.key} defaultValue={String(s.value)} className="border rounded px-2 py-1">
                      {s.input.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : s.input.type === "textarea" ? (
                    <textarea id={s.key} name={s.key} defaultValue={String(s.value)} className="border rounded px-2 py-1 w-full" />
                  ) : (
                    <input
                      id={s.key}
                      name={s.key}
                      type={s.input.type === "number" ? "number" : "text"}
                      defaultValue={String(s.value)}
                      min={s.input.type === "number" ? s.input.min : undefined}
                      max={s.input.type === "number" ? s.input.max : undefined}
                      className="border rounded px-2 py-1"
                    />
                  )}
                  <div className="flex items-center gap-2 pt-1">
                    <button type="submit" className={buttonClasses("primary", "sm")}>
                      Save
                    </button>
                    {s.isOverridden && (
                      <span className="text-xs text-amber-600">Overridden (default: not in use)</span>
                    )}
                  </div>
                </form>
                {s.isOverridden && (
                  <form action={resetAction} className="pt-2">
                    <input type="hidden" name="__key" value={s.key} />
                    <button type="submit" className={buttonClasses("outline", "sm")}>
                      Reset to default
                    </button>
                  </form>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Verify types and lint**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run lint`
Expected: PASS (no errors in the new files).

> If `buttonClasses` signature differs from `("primary", "sm")` / `("outline", "sm")`,
> match the exact signature used in `src/app/admin/page.tsx` (which calls
> `buttonClasses("outline", "sm")`).

- [ ] **Step 3: Manual smoke test**

Run: `npm run dev`, then visit `http://localhost:3000/admin/settings` signed in as a Platform Admin.
Expected: an "Operations" group with the "Max procedures per RHD session" field showing `3`. Change it to `5`, Save → page shows "Saved." and the field shows `5`, a "Reset to default" button appears. Click Reset → field returns to `3`.

- [ ] **Step 4: Commit**

```bash
git add src/app/admin/settings/page.tsx
git commit -m "feat(settings): admin Settings page with auto-rendered, audited forms"
```

> **On the RBAC gate test (spec Testing §):** the page and both actions gate on
> `requirePermission("admin.manage_settings")` — the same shared helper every
> other admin page uses, already covered by the RBAC engine tests
> (`src/platform/rbac/engine.test.ts`) and `requirePermission`'s own behavior.
> The repo does not unit-test server components/actions in isolation, so we do
> not add a bespoke (brittle) render test here; the security boundary is the
> tested `can()` engine, not this page. This is a deliberate decision, not a gap.

---

## Task 7: Full verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS (including the new registry + service suites).

- [ ] **Step 2: Typecheck + lint the whole project**

Run: `npm run typecheck && npm run lint`
Expected: both PASS.

- [ ] **Step 3: Confirm the canary loop end-to-end (optional manual)**

With `npm run dev` running and signed in as admin: set "Max procedures per RHD session" to a distinct value, then load the schedule builder RHD readiness view and confirm it reflects the new cap (allowing for the ~30s worker cache TTL if the value is read by the worker; the request-path read is immediate after cache invalidation).

- [ ] **Step 4: Final commit (if any uncommitted changes remain)**

```bash
git add -A
git commit -m "chore(settings): Phase 0 foundation verification"
```

---

## Notes for the implementer

- **Why a `define()` helper in the registry:** it keeps each entry type-checked against `SettingDef<T>` while the array stays `SettingDef<unknown>[]`, avoiding Zod schema variance errors. Don't replace it with `any`.
- **Cache and the worker:** the resolver cache is per-process with a 30s TTL. The web process invalidates immediately on write; the separate worker process picks up changes within the TTL. This is intentional (spec §3) — do not add cross-process invalidation in Phase 0.
- **Secrets stay in env:** never add a registry entry for `AUTH_SECRET`, `*_CLIENT_SECRET`, `AIRTABLE_PAT`, or the auth-bootstrap IDs. The `secret: false` field is a guard/reminder, not a toggle.
- **Adding future settings (Phases 1-3):** add a `define<T>({...})` entry to `SETTINGS` and migrate the corresponding `config.X` call sites to `await getSetting<T>("...")`. No page or service changes needed — the form auto-renders.
