# Settings Phase 2b — Logo + Favicon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin upload a custom logo and favicon from /admin/settings, served publicly via an app route, falling back to the bundled HAVEN defaults.

**Architecture:** Branding assets are stored privately via `storage.ts` and exposed through a public route `GET /api/branding/[asset]` that streams the bytes (or 302s to the bundled default). Each asset's setting value is a `{ contentType, version }` descriptor managed by upload/remove server actions, not a text field. The settings page gains an `image` widget; `HavenLogo` (async) and the favicon (`generateMetadata`) point at the route.

**Tech Stack:** Next.js 16 App Router (Route Handlers, Server Actions, async Server Components), Prisma, Zod, Vitest. Reuses: settings `getSetting`/`setSetting`/`resetSetting`/`getCategory` (`@/platform/settings/service`); `SETTINGS`/`define`/`SettingInput` (`@/platform/settings/registry`); `putObject`/`getObject`/`deleteObject` (`@/platform/storage`).

**Spec:** `docs/superpowers/specs/2026-06-09-settings-phase-2b-logo-favicon-design.md`

**Branch:** `feat/admin-configurable-settings` (same as prior phases, PR #20). Do NOT create a branch.

**Environment:** Run DB tests with plain `npx vitest run <path>` (test DB at localhost:5434 up; the test env stores uploads on local disk under `/tmp/havenhub-test-uploads`; never set DATABASE_URL or use `--env-file`). There is an UNRELATED uncommitted WIP change in `src/platform/auth/inactivity.tsx` with one pre-existing eslint error — do NOT touch/stage/commit it; `git add` only the listed files; ignore that single lint error.

---

## File Structure

- Create `src/platform/branding/asset-types.ts` — constants, `BrandingAsset` type, Zod schema (no settings imports, so the registry can import it without a cycle).
- Create `src/platform/branding/assets.ts` — `saveBrandingAsset`/`removeBrandingAsset`/`readBrandingAsset` + `BrandingAssetError`.
- Modify `src/platform/settings/registry.ts` — `image` input type + 2 entries.
- Create `src/app/api/branding/[asset]/route.ts` — public serving.
- Create `src/app/admin/settings/branding-image-field.tsx` — the upload widget (server component).
- Modify `src/app/admin/settings/page.tsx` — upload/remove actions + render the widget for `image` settings.
- Modify `src/platform/ui/haven-logo.tsx` — async, mask → route.
- Modify `src/app/layout.tsx` — favicon in `generateMetadata`.
- Delete `src/app/icon.svg`.

---

## Task 1: Asset types + registry image type + entries

**Files:**
- Create: `src/platform/branding/asset-types.ts`
- Modify: `src/platform/settings/registry.ts`
- Test: `src/platform/settings/service.test.ts` (extend)

- [ ] **Step 1: Create the asset-types module**

Create `src/platform/branding/asset-types.ts`:

```ts
import { z } from "zod";

/** The branding assets that can be uploaded. */
export const BRANDING_ASSETS = ["logo", "favicon"] as const;
export type BrandingAssetName = (typeof BRANDING_ASSETS)[number];

/** Descriptor stored in the setting value. contentType "" means "no custom asset". */
export type BrandingAsset = { contentType: string; version: number };

export const brandingAssetSchema = z.object({
  contentType: z.string(),
  version: z.number().int().nonnegative(),
});
```

- [ ] **Step 2: Write a failing resolver test**

Append to `src/platform/settings/service.test.ts`:

```ts
describe("phase 2b branding asset settings", () => {
  it("resolves branding.logo to the default descriptor", async () => {
    expect(await getSetting("branding.logo")).toEqual({ contentType: "", version: 0 });
  });

  it("resolves a stored branding.favicon descriptor", async () => {
    await prisma.setting.create({
      data: { key: "branding.favicon", value: { contentType: "image/png", version: 2 } },
    });
    _resetSettingsCache();
    expect(await getSetting("branding.favicon")).toEqual({ contentType: "image/png", version: 2 });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/platform/settings/service.test.ts -t "branding asset settings"`
Expected: FAIL — `Unregistered setting key: branding.logo`.

- [ ] **Step 4: Add the `image` input type + two entries**

In `src/platform/settings/registry.ts`, add `image` to the `SettingInput` union (after `color`):

```ts
  | { type: "color" }
  | { type: "image" }
```

Add the import at the top (alongside the existing imports):

```ts
import { brandingAssetSchema, type BrandingAsset } from "@/platform/branding/asset-types";
```

Append to the `SETTINGS` array:

```ts
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
    envDefault: () => ({ contentType: "", version: 0 }),
    secret: false,
  }),
```

- [ ] **Step 5: Run the resolver test to verify it passes**

Run: `npx vitest run src/platform/settings/service.test.ts -t "branding asset settings"`
Expected: PASS (2 tests). The existing registry test ("every envDefault satisfies its own schema") also now covers both descriptor defaults.

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck` → clean. Run: `npm run lint` → no new errors. Run: `npx vitest run src/platform/settings` → PASS.

```bash
git add src/platform/branding/asset-types.ts src/platform/settings/registry.ts src/platform/settings/service.test.ts
git commit -m "feat(settings): image input type and branding.logo/favicon asset descriptors"
```

---

## Task 2: branding-assets service

**Files:**
- Create: `src/platform/branding/assets.ts`
- Test: `src/platform/branding/assets.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/platform/branding/assets.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache, getSetting } from "@/platform/settings/service";
import { getObject } from "@/platform/storage";
import {
  saveBrandingAsset,
  removeBrandingAsset,
  readBrandingAsset,
  BrandingAssetError,
} from "./assets";

beforeEach(async () => { await resetDb(); _resetSettingsCache(); });

const png = (): { name: string; type: string; size: number; bytes: Buffer } => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic-ish
  return { name: "logo.png", type: "image/png", size: bytes.length, bytes };
};

describe("saveBrandingAsset", () => {
  it("rejects a disallowed mime type", async () => {
    await expect(
      saveBrandingAsset("logo", { name: "x.gif", type: "image/gif", size: 4, bytes: Buffer.from([1, 2, 3, 4]) }, null)
    ).rejects.toBeInstanceOf(BrandingAssetError);
    expect(await prisma.setting.findUnique({ where: { key: "branding.logo" } })).toBeNull();
  });

  it("rejects an oversize file", async () => {
    const big = { name: "logo.png", type: "image/png", size: 999 * 1024 * 1024, bytes: Buffer.from([1]) };
    await expect(saveBrandingAsset("logo", big, null)).rejects.toBeInstanceOf(BrandingAssetError);
  });

  it("stores bytes and bumps the version on each upload", async () => {
    await saveBrandingAsset("logo", png(), "person-1");
    expect(await getSetting("branding.logo")).toMatchObject({ contentType: "image/png", version: 1 });
    expect(await getObject("branding/logo")).not.toBeNull();

    _resetSettingsCache();
    await saveBrandingAsset("logo", png(), "person-1");
    expect(await getSetting("branding.logo")).toMatchObject({ version: 2 });
  });
});

describe("readBrandingAsset", () => {
  it("returns null when no custom asset is set", async () => {
    expect(await readBrandingAsset("favicon")).toBeNull();
  });

  it("returns the contentType and bytes when present", async () => {
    await saveBrandingAsset("favicon", { ...png(), name: "f.png" }, null);
    _resetSettingsCache();
    const read = await readBrandingAsset("favicon");
    expect(read?.contentType).toBe("image/png");
    expect(read?.bytes).toBeInstanceOf(Buffer);
  });
});

describe("removeBrandingAsset", () => {
  it("deletes the object and resets the descriptor to default", async () => {
    await saveBrandingAsset("logo", png(), null);
    _resetSettingsCache();
    await removeBrandingAsset("logo", null);
    expect(await getSetting("branding.logo")).toEqual({ contentType: "", version: 0 });
    expect(await getObject("branding/logo")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/platform/branding/assets.test.ts`
Expected: FAIL — cannot resolve `./assets`.

- [ ] **Step 3: Write the service**

Create `src/platform/branding/assets.ts`:

```ts
import { getSetting, setSetting, resetSetting } from "@/platform/settings/service";
import { putObject, getObject, deleteObject } from "@/platform/storage";
import { type BrandingAsset, type BrandingAssetName } from "./asset-types";

const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

/** Thrown when an uploaded branding asset is the wrong type or too large. */
export class BrandingAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandingAssetError";
  }
}

/** Storage key for an asset's bytes. */
function assetKey(asset: BrandingAssetName): string {
  return `branding/${asset}`;
}

/** Validate the upload, store the bytes, and bump the descriptor (contentType + version). */
export async function saveBrandingAsset(
  asset: BrandingAssetName,
  file: { name: string; type: string; size: number; bytes: Buffer },
  actorPersonId: string | null
): Promise<void> {
  if (!ALLOWED_TYPES.has(file.type)) {
    throw new BrandingAssetError(
      `Unsupported image type "${file.type}". Use PNG, JPEG, WebP, or ICO.`
    );
  }
  const maxMb = await getSetting<number>("uploads.maxMb");
  if (file.size > maxMb * 1024 * 1024) {
    throw new BrandingAssetError(`Image too large; the limit is ${maxMb} MB.`);
  }

  await putObject(assetKey(asset), file.bytes, file.type);
  const current = await getSetting<BrandingAsset>(`branding.${asset}`);
  await setSetting(
    `branding.${asset}`,
    { contentType: file.type, version: current.version + 1 },
    actorPersonId
  );
}

/** Remove the custom asset; the descriptor resets to default so the route serves the bundled default. */
export async function removeBrandingAsset(
  asset: BrandingAssetName,
  actorPersonId: string | null
): Promise<void> {
  await deleteObject(assetKey(asset));
  await resetSetting(`branding.${asset}`, actorPersonId);
}

/** For the public route: the descriptor + bytes, or null when no custom asset exists. */
export async function readBrandingAsset(
  asset: BrandingAssetName
): Promise<{ contentType: string; bytes: Buffer } | null> {
  const desc = await getSetting<BrandingAsset>(`branding.${asset}`);
  if (!desc.contentType) return null;
  const bytes = await getObject(assetKey(asset));
  if (!bytes) return null;
  return { contentType: desc.contentType, bytes };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/branding/assets.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify + commit**

Run: `npm run typecheck` → clean. Run: `npm run lint` → no new errors.

```bash
git add src/platform/branding/assets.ts src/platform/branding/assets.test.ts
git commit -m "feat(settings): branding-assets service (upload, remove, read)"
```

---

## Task 3: Public asset route

**Files:**
- Create: `src/app/api/branding/[asset]/route.ts`
- Test: `src/app/api/branding/[asset]/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/branding/[asset]/route.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache } from "@/platform/settings/service";
import { saveBrandingAsset } from "@/platform/branding/assets";
import { GET } from "./route";

function ctx(asset: string) {
  return { params: Promise.resolve({ asset }) };
}

beforeEach(async () => { await resetDb(); _resetSettingsCache(); });

describe("GET /api/branding/[asset]", () => {
  it("404s for an unknown asset", async () => {
    const res = await GET(new Request("http://localhost/api/branding/bogus"), ctx("bogus"));
    expect(res.status).toBe(404);
  });

  it("redirects to the bundled default when no custom asset is set", async () => {
    const res = await GET(new Request("http://localhost/api/branding/logo"), ctx("logo"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/brand/haven-logo-white.png");
  });

  it("serves the stored bytes with content-type and nosniff when present", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await saveBrandingAsset("favicon", { name: "f.png", type: "image/png", size: bytes.length, bytes }, null);
    _resetSettingsCache();

    const res = await GET(new Request("http://localhost/api/branding/favicon"), ctx("favicon"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run "src/app/api/branding/[asset]/route.test.ts"`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Write the route**

Create `src/app/api/branding/[asset]/route.ts`:

```ts
import { BRANDING_ASSETS, type BrandingAssetName } from "@/platform/branding/asset-types";
import { readBrandingAsset } from "@/platform/branding/assets";

type RouteContext = { params: Promise<{ asset: string }> };

/**
 * GET /api/branding/[asset] -- public branding asset serving.
 *
 * Unauthenticated by design (branding is public). Serves the admin-uploaded image
 * for "logo"/"favicon", or 302-redirects to the bundled default when none is set.
 * Raster-only uploads + nosniff + a restrictive CSP neutralize any active content.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { asset } = await context.params;
  if (!(BRANDING_ASSETS as readonly string[]).includes(asset)) {
    return new Response("Not found", { status: 404 });
  }
  const name = asset as BrandingAssetName;

  const custom = await readBrandingAsset(name);
  if (!custom) {
    const fallback = name === "logo" ? "/brand/haven-logo-white.png" : "/brand/haven-favicon.png";
    return Response.redirect(new URL(fallback, request.url), 302);
  }

  return new Response(new Uint8Array(custom.bytes), {
    status: 200,
    headers: {
      "Content-Type": custom.contentType,
      "Cache-Control": "public, max-age=300, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "src/app/api/branding/[asset]/route.test.ts"`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify + commit**

Run: `npm run typecheck` → clean. Run: `npm run lint` → no new errors.

```bash
git add "src/app/api/branding/[asset]/route.ts" "src/app/api/branding/[asset]/route.test.ts"
git commit -m "feat(settings): public branding asset route with default fallback"
```

---

## Task 4: Settings page image widget + upload/remove actions

**Files:**
- Create: `src/app/admin/settings/branding-image-field.tsx`
- Modify: `src/app/admin/settings/page.tsx`

- [ ] **Step 1: Create the image-field component**

Create `src/app/admin/settings/branding-image-field.tsx`:

```tsx
import { buttonClasses } from "@/platform/ui/button";
import type { ResolvedSetting } from "@/platform/settings/service";

/**
 * Upload widget for an `image` setting: current preview + file picker + (when a
 * custom asset is set) a "Use default" button. The two server actions are passed
 * from the settings page so they keep its permission gate.
 */
export function BrandingImageField({
  setting,
  uploadAction,
  removeAction,
}: {
  setting: ResolvedSetting;
  uploadAction: (formData: FormData) => Promise<void>;
  removeAction: (formData: FormData) => Promise<void>;
}) {
  const asset = setting.key.replace("branding.", "");
  const value = setting.value as { contentType: string; version: number };
  const hasCustom = value.contentType !== "";

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium">{setting.label}</label>
      <p className="text-xs text-gray-500">{setting.help}</p>
      {/* eslint-disable-next-line @next/next/no-img-element -- dynamic same-origin asset route, not a static import */}
      <img
        src={`/api/branding/${asset}?v=${value.version}`}
        alt={`${setting.label} preview`}
        className="h-12 max-w-[200px] rounded border bg-slate-100 object-contain p-1"
      />
      <form action={uploadAction} encType="multipart/form-data" className="flex items-center gap-2">
        <input type="hidden" name="__asset" value={asset} />
        <input
          type="file"
          name="file"
          accept="image/png,image/jpeg,image/webp,image/x-icon"
          className="text-sm"
        />
        <button type="submit" className={buttonClasses("primary", "sm")}>
          Upload
        </button>
      </form>
      {hasCustom && (
        <form action={removeAction}>
          <input type="hidden" name="__asset" value={asset} />
          <button type="submit" className={buttonClasses("outline", "sm")}>
            Use default
          </button>
        </form>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the two server actions to the settings page**

In `src/app/admin/settings/page.tsx`, add imports at the top:

```ts
import { BRANDING_ASSETS, type BrandingAssetName } from "@/platform/branding/asset-types";
import { saveBrandingAsset, removeBrandingAsset, BrandingAssetError } from "@/platform/branding/assets";
import { BrandingImageField } from "./branding-image-field";
```

Inside `SettingsPage`, alongside the existing `updateAction`/`resetAction`, add:

```ts
  async function uploadBrandingAction(formData: FormData) {
    "use server";
    const session = await requirePermission(PERMISSION);
    const asset = String(formData.get("__asset"));
    if (!BRANDING_ASSETS.includes(asset as BrandingAssetName)) {
      redirect(`/admin/settings?error=${encodeURIComponent("Unknown asset")}`);
    }
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      redirect(`/admin/settings?error=${encodeURIComponent("Choose an image file to upload")}`);
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    try {
      await saveBrandingAsset(
        asset as BrandingAssetName,
        { name: file.name, type: file.type, size: file.size, bytes },
        session.personId
      );
    } catch (err) {
      if (err instanceof BrandingAssetError) {
        redirect(`/admin/settings?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath("/admin/settings");
    redirect("/admin/settings?saved=1");
  }

  async function removeBrandingAction(formData: FormData) {
    "use server";
    const session = await requirePermission(PERMISSION);
    const asset = String(formData.get("__asset"));
    if (!BRANDING_ASSETS.includes(asset as BrandingAssetName)) {
      redirect(`/admin/settings?error=${encodeURIComponent("Unknown asset")}`);
    }
    await removeBrandingAsset(asset as BrandingAssetName, session.personId);
    revalidatePath("/admin/settings");
    redirect("/admin/settings?saved=1");
  }
```

- [ ] **Step 3: Render the widget for `image` settings**

In the `settings.map((s) => ...)` body in `page.tsx`, branch on the image type. The current body renders a `<div className="rounded-lg border ...">` containing the `<form action={updateAction}>`. Wrap so `image` settings render the widget instead. Change the inner content of the per-setting `<div>` to:

```tsx
              <div key={s.key} className="rounded-lg border border-gray-200 p-4">
                {s.input.type === "image" ? (
                  <BrandingImageField
                    setting={s}
                    uploadAction={uploadBrandingAction}
                    removeAction={removeBrandingAction}
                  />
                ) : (
                  <>
                    {/* existing <form action={updateAction}> ... </form> and the reset <form> stay here unchanged */}
                  </>
                )}
              </div>
```

Concretely: keep the existing `<form action={updateAction}>...</form>` and the `{s.isOverridden && <form action={resetAction}>...}` exactly as they are, but move them inside the `: (` <>...</> ) branch of the ternary above. Do not change their contents.

- [ ] **Step 4: Verify**

Run: `npm run typecheck` → clean.
Run: `npm run lint` → no new errors (ignore inactivity.tsx).
Run: `npm run build` → succeeds; `/admin/settings` and `/api/branding/[asset]` appear in the route manifest.

(No unit test: the page is a server component with server actions, which the repo does not unit-test; the actions delegate to the Task-2 service, which is tested. Coverage is the service + route tests + build + manual smoke.)

- [ ] **Step 5: Commit**

```bash
git add src/app/admin/settings/branding-image-field.tsx src/app/admin/settings/page.tsx
git commit -m "feat(settings): logo/favicon upload widget on the admin settings page"
```

---

## Task 5: Consumers — async logo + dynamic favicon

**Files:**
- Modify: `src/platform/ui/haven-logo.tsx`
- Modify: `src/app/layout.tsx`
- Delete: `src/app/icon.svg`
- Test: `src/platform/ui/haven-logo.test.ts`

- [ ] **Step 1: Write the failing logo test**

Create `src/platform/ui/haven-logo.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache } from "@/platform/settings/service";
import { HavenLogo } from "./haven-logo";

beforeEach(async () => { await resetDb(); _resetSettingsCache(); });

describe("HavenLogo", () => {
  it("points the mask at the branding route with the default version", async () => {
    const el = await HavenLogo({ className: "h-8" });
    const style = el.props.style as { maskImage: string };
    expect(style.maskImage).toBe("url(/api/branding/logo?v=0)");
  });

  it("uses the stored logo version as a cache-buster", async () => {
    await prisma.setting.create({
      data: { key: "branding.logo", value: { contentType: "image/png", version: 3 } },
    });
    _resetSettingsCache();
    const el = await HavenLogo({});
    const style = el.props.style as { maskImage: string };
    expect(style.maskImage).toBe("url(/api/branding/logo?v=3)");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/platform/ui/haven-logo.test.ts`
Expected: FAIL — current `HavenLogo` is sync and uses a static mask URL.

- [ ] **Step 3: Make `HavenLogo` async and route-backed**

Replace `src/platform/ui/haven-logo.tsx` with:

```tsx
import type { CSSProperties } from "react";
import { getSetting } from "@/platform/settings/service";
import type { BrandingAsset } from "@/platform/branding/asset-types";

function maskStyle(url: string): CSSProperties {
  return {
    maskImage: `url(${url})`,
    WebkitMaskImage: `url(${url})`,
    maskSize: "contain",
    WebkitMaskSize: "contain",
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskPosition: "left center",
    WebkitMaskPosition: "left center",
    backgroundColor: "currentColor",
  };
}

/**
 * The app logo lockup, rendered via CSS mask so one asset serves every color: set
 * the text color and the logo follows (white on the brand panel, brand color on
 * light surfaces). The mask points at the public branding route, which serves the
 * admin-uploaded logo or the bundled default. The `?v=` is a cache-buster.
 */
export async function HavenLogo({ className }: { className?: string }) {
  // Resolve the cache-buster version, but never let a settings/DB failure break
  // the page -- HavenLogo also renders on not-found/error pages. Fall back to the
  // default asset (version 0) when settings can't be read.
  let version = 0;
  try {
    version = (await getSetting<BrandingAsset>("branding.logo")).version;
  } catch {
    // settings unavailable; serve the default logo via version 0
  }
  return (
    <div
      role="img"
      aria-label="Logo"
      className={`aspect-[1500/490] ${className ?? ""}`}
      style={maskStyle(`/api/branding/logo?v=${version}`)}
    />
  );
}
```

(All `HavenLogo` callers are async Server Components — login, welcome, not-found, app-shell — so an async component renders fine without changes at the call sites.)

- [ ] **Step 4: Run the logo test to verify it passes**

Run: `npx vitest run src/platform/ui/haven-logo.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the favicon to generateMetadata**

In `src/app/layout.tsx`, replace the existing `generateMetadata` (added in 2a) with one that also resolves the favicon descriptor:

```ts
export async function generateMetadata(): Promise<Metadata> {
  const [name, favicon] = await Promise.all([
    getSetting<string>("branding.appName"),
    getSetting<{ contentType: string; version: number }>("branding.favicon"),
  ]);
  return {
    title: name,
    description: `The unified platform for ${name}`,
    icons: { icon: `/api/branding/favicon?v=${favicon.version}` },
  };
}
```

- [ ] **Step 6: Delete the static favicon file**

Next's file-based `icon.svg` convention takes precedence over `metadata.icons`. Remove it so the dynamic favicon wins:

```bash
git rm src/app/icon.svg
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck` → clean.
Run: `npm run lint` → no new errors.
Run: `npx vitest run src/platform/ui/haven-logo.test.ts` → PASS.
Run: `npm run build` → succeeds; confirm there is no `/icon.svg` route now and the favicon is set via metadata (build output shows no `○ /icon.svg`).

- [ ] **Step 8: Commit**

```bash
git add src/platform/ui/haven-logo.tsx src/app/layout.tsx
git rm src/app/icon.svg
git commit -m "feat(settings): logo and favicon read from the branding route"
```

---

## Task 6: Full verification

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS (all suites incl. the new branding service + route + logo tests).

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: typecheck clean; lint shows ONLY the pre-existing `src/platform/auth/inactivity.tsx` error.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: succeeds; `/admin/settings` and `/api/branding/[asset]` in the route manifest; no `/icon.svg`.

- [ ] **Step 4: Manual smoke (optional)**

`npm run dev`, sign in as Platform Admin, open `/admin/settings` → the **Branding** group shows Logo + Favicon image widgets with the current default preview. Upload a PNG logo → it appears (tinted) in the app shell + login; "Use default" restores HAVEN's lockup. Upload a favicon → the browser-tab icon updates on reload. Confirm a non-image (e.g. a PDF) upload is rejected with the validation message.

- [ ] **Step 5: Final commit (if anything uncommitted besides the WIP file)**

```bash
git add -A -- ':!src/platform/auth/inactivity.tsx'
git commit -m "chore(settings): Phase 2b verification" || echo "nothing to commit"
```

---

## Notes for the implementer

- **No import cycle:** `asset-types.ts` imports only `zod`; both `registry.ts` and `assets.ts` import from it. `assets.ts` imports the settings service; `registry.ts` must NOT import `assets.ts`.
- **Private storage, public route:** bytes are stored via `putObject` (private on Blob) and only ever leave through the `/api/branding/[asset]` route, which reads them server-side via `getObject` and streams them. Do not try to hand out a Blob URL.
- **SVG is intentionally rejected** (XSS). Do not add `image/svg+xml` to `ALLOWED_TYPES`.
- **Favicon caching:** the `?v=version` query is the cache-buster; do not drop it.
- **WIP file:** never touch/stage `src/platform/auth/inactivity.tsx`; `git add` only the listed files.
