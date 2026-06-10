# Admin-Configurable Settings — Phase 2b: Logo + Favicon

**Date:** 2026-06-09
**Status:** Design for approval
**Depends on:** Phase 0/1/2a (PR #20). Reuses the registry/resolver/settings page and the storage abstraction.

## Goal

Let an admin upload a custom logo and favicon from `/admin/settings`, served publicly,
falling back to the bundled HAVEN defaults when none is set. Completes the visible
"branding" surface (app name + color shipped in 2a).

## Key constraint (drives the design)

`src/platform/storage.ts` stores Blob objects with `access: "private"` — bytes are
only readable server-side via `getObject(key)`, never through a public Blob URL.
But a logo (CSS mask-image) and favicon (`<link rel=icon>`) are fetched **publicly
by the browser**. So branding assets are stored privately and exposed through a
**public app route** that streams `getObject` bytes. This works identically for the
local-disk and Blob drivers.

## Scope

- `branding.logo`, `branding.favicon` settings — value is an asset descriptor, set
  by upload (not a text field).
- A new `image` input type; the settings page renders an upload widget (preview +
  file picker + "Use default") for it, in the existing **Branding** category.
- Upload + remove server actions backed by a small `branding-assets` service.
- Public route `GET /api/branding/[asset]` serving the stored image or redirecting
  to the bundled default.
- Consumers: `HavenLogo` points its mask at the route; the favicon goes dynamic via
  `generateMetadata` (the static `src/app/icon.svg` is removed).

### Out of scope (deliberate)

- **SVG uploads.** A same-origin user-uploaded SVG can execute script if opened
  directly — an XSS vector. Allow only raster formats (`image/png`, `image/jpeg`,
  `image/webp`, `image/x-icon`/`image/vnd.microsoft.icon`). The current logo/favicon
  are PNG, so nothing is lost.
- `HavenMark` (the inline "HAVEN" circle SVG) — a secondary mark; left as-is.
- App name, brand color — done in 2a. Brand colors of the logo (it is tinted
  monochrome per 2a's `--color-brand`) are unaffected.

## Design

### 1. Asset descriptor + registry entries

The value of each branding-asset setting is a small descriptor (not a form scalar):

```ts
// shape stored in the Setting row
type BrandingAsset = { contentType: string; version: number };
// default = no custom asset:
const DEFAULT_ASSET = { contentType: "", version: 0 };
```

`contentType === ""` means "no custom asset, use the bundled default". `version`
increments on each upload and is used as a cache-buster in the public URL.

Registry entries (auto-rendered in the **Branding** group, but with the `image`
widget):

```ts
const ASSET_SCHEMA = z.object({
  contentType: z.string(),
  version: z.number().int().nonnegative(),
});

define<BrandingAsset>({
  key: "branding.logo",
  category: "Branding",
  label: "Logo",
  help: "Monochrome/transparent PNG silhouette. It is tinted to the brand color automatically. PNG, JPEG, or WebP.",
  input: { type: "image" },
  schema: ASSET_SCHEMA,
  envDefault: () => ({ contentType: "", version: 0 }),
  secret: false,
}),
define<BrandingAsset>({
  key: "branding.favicon",
  category: "Branding",
  label: "Favicon",
  help: "Small square icon shown in the browser tab. PNG, ICO, or WebP.",
  input: { type: "image" },
  schema: ASSET_SCHEMA,
  envDefault: () => ({ contentType: "", version: 0 }),
  secret: false,
}),
```

Add `| { type: "image" }` to `SettingInput`.

### 2. branding-assets service (`src/platform/branding/assets.ts`, new)

```ts
export const BRANDING_ASSETS = ["logo", "favicon"] as const;
export type BrandingAssetName = (typeof BRANDING_ASSETS)[number];

const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp", "image/x-icon", "image/vnd.microsoft.icon"]);

export class BrandingAssetError extends Error {}

/** storage key for an asset's bytes */
function assetKey(asset: BrandingAssetName): string { return `branding/${asset}`; }

/** Validate + store the bytes, then bump the descriptor (contentType + version). */
export async function saveBrandingAsset(
  asset: BrandingAssetName,
  file: { name: string; type: string; size: number; bytes: Buffer },
  actorPersonId: string | null
): Promise<void> {
  if (!ALLOWED.has(file.type)) throw new BrandingAssetError(`Unsupported image type "${file.type}". Use PNG, JPEG, WebP, or ICO.`);
  const maxBytes = (await getSetting<number>("uploads.maxMb")) * 1024 * 1024;
  if (file.size > maxBytes) throw new BrandingAssetError(`Image too large (max ${maxBytes / 1024 / 1024} MB).`);

  await putObject(assetKey(asset), file.bytes, file.type);
  const current = await getSetting<BrandingAsset>(`branding.${asset}`);
  await setSetting(`branding.${asset}`, { contentType: file.type, version: current.version + 1 }, actorPersonId);
}

/** Remove the custom asset; the descriptor resets to default (-> bundled default served). */
export async function removeBrandingAsset(asset: BrandingAssetName, actorPersonId: string | null): Promise<void> {
  await deleteObject(assetKey(asset));
  await resetSetting(`branding.${asset}`, actorPersonId);  // clears the override -> { "", 0 }
}

/** For the public route: the descriptor + bytes (or null when no custom asset). */
export async function readBrandingAsset(asset: BrandingAssetName): Promise<{ contentType: string; bytes: Buffer } | null> {
  const desc = await getSetting<BrandingAsset>(`branding.${asset}`);
  if (!desc.contentType) return null;
  const bytes = await getObject(assetKey(asset));
  if (!bytes) return null;
  return { contentType: desc.contentType, bytes };
}
```

(`setSetting`/`resetSetting`/`getSetting` from the settings service; `putObject`/
`getObject`/`deleteObject` from storage.)

### 3. Public asset route (`src/app/api/branding/[asset]/route.ts`, new)

```ts
export async function GET(req, { params }) {
  const { asset } = await params;
  if (!BRANDING_ASSETS.includes(asset)) return new Response("Not found", { status: 404 });

  const custom = await readBrandingAsset(asset);
  if (!custom) {
    // No custom asset: redirect to the bundled default in /public/brand.
    const fallback = asset === "logo" ? "/brand/haven-logo-white.png" : "/brand/haven-favicon.png";
    return Response.redirect(new URL(fallback, req.url), 302);
  }
  return new Response(custom.bytes, {
    headers: {
      "Content-Type": custom.contentType,
      "Cache-Control": "public, max-age=300, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
```

Security: `nosniff` blocks content-type confusion; the restrictive CSP neutralizes
any embedded active content; raster-only validation (service) keeps SVG out.
Unauthenticated by design — branding is public.

### 4. Settings page: the `image` widget

For `s.input.type === "image"`, the page renders (instead of the standard input +
Save form): a preview `<img src={\`/api/branding/${assetName}?v=${version}\`} />`, a
file-upload `<form action={uploadBrandingAction} encType="multipart/form-data">`
(hidden `__asset`, `<input type="file" name="file" accept="image/png,image/jpeg,image/webp,image/x-icon">`,
Upload button), and — when a custom asset exists (`contentType !== ""`) — a
"Use default" button posting to `removeBrandingAction`. `assetName` and `version`
come from the resolved setting (`s.key` minus the `branding.` prefix; `s.value`).

Two new inline `"use server"` actions on the settings page (gated by
`admin.manage_settings`, like the existing ones):
- `uploadBrandingAction(formData)`: read `__asset` + the `File`; build the
  descriptor `{ name, type, size, bytes: Buffer.from(await file.arrayBuffer()) }`;
  call `saveBrandingAsset`; on `BrandingAssetError` redirect with `?error=`;
  else `revalidatePath` + `?saved=1`.
- `removeBrandingAction(formData)`: read `__asset`; call `removeBrandingAsset`;
  revalidate.

Note: the standard `updateAction`/`coerce` path is **not** used for `image`
settings (they never render a text input), so no `coerce` change is needed.

### 5. Consumers

**Logo** — `src/platform/ui/haven-logo.tsx`. Make `HavenLogo` an async server
component (all callers are server components) that reads `branding.logo` and points
the CSS mask at the public route with a cache-buster:

```tsx
export async function HavenLogo({ className }: { className?: string }) {
  const { version } = await getSetting<{ contentType: string; version: number }>("branding.logo");
  const url = `/api/branding/logo?v=${version}`;
  const style = { ...maskStyleFor(url), backgroundColor: "currentColor" };
  return <div role="img" aria-label="Logo" className={`aspect-[1500/490] ${className ?? ""}`} style={style} />;
}
```

The mask URL always hits the route, which serves the custom logo or redirects to
the bundled `haven-logo-white.png` — so tinting (2a `currentColor`/`--color-brand`)
still works for both. (The `aspect-[1500/490]` ratio matches the default asset; a
custom logo of a different ratio may letterbox within the mask box — acceptable for
v1; a future enhancement could store intrinsic dimensions.)

**Favicon** — delete `src/app/icon.svg` (so Next's file convention stops taking
precedence), and extend the existing `generateMetadata` in `src/app/layout.tsx`
(added in 2a) to set `icons`:

```ts
const [name, favicon] = await Promise.all([
  getSetting<string>("branding.appName"),
  getSetting<{ contentType: string; version: number }>("branding.favicon"),
]);
return {
  title: name,
  description: `The unified platform for ${name}`,
  icons: { icon: `/api/branding/favicon?v=${favicon.version}` },
};
```

The favicon link always points at the route (custom or default-by-redirect); the
`?v=version` busts the browser's aggressive favicon cache on change.

### 6. config.ts

Unchanged. Branding assets have no env vars; descriptors live in settings, bytes in
storage.

## Testing

- **branding-assets service** (DB + storage): `saveBrandingAsset` rejects a
  disallowed mime; rejects oversize; on success calls `putObject` and bumps
  `version` (1 then 2 on a second upload). `removeBrandingAsset` deletes the object
  and resets the descriptor to `{ "", 0 }`. `readBrandingAsset` returns null when no
  custom asset, and `{ contentType, bytes }` when present. (Use the local-disk
  storage driver — the test env has no `BLOB_READ_WRITE_TOKEN`.)
- **Public route**: returns the stored bytes + `Content-Type` + `nosniff` when a
  custom asset exists; returns a 302 to the bundled default when none; 404 for an
  unknown `asset` param.
- **Registry**: the two `image` entries are valid; default descriptor passes
  `ASSET_SCHEMA`; `image` is a valid `SettingInput`.
- **HavenLogo**: async resolves the version into the mask URL (render the component
  in a test or assert the helper builds `/api/branding/logo?v=N`).
- **Manual smoke**: upload a PNG logo → it appears (tinted) in the app shell / login;
  "Use default" restores HAVEN's. Upload a favicon → tab icon updates after reload.

## Risks & mitigations

- **SVG XSS** — excluded by raster-only validation + `nosniff` + restrictive CSP on
  the asset response.
- **Mask-image following a 302 (default case)** — browsers follow redirects for
  `mask-image`/`<link icon>`; the default path is exercised in the manual smoke. If
  a redirect proves unreliable for masks in practice, the route can stream the
  default bytes instead (read from `/public/brand`) — noted, not pre-optimized.
- **Favicon caching** — addressed by the `?v=version` cache-buster; browsers refetch
  when the version changes.
- **Blob private read latency** — the route does one `getObject` per request behind a
  5-minute CDN cache; negligible.

## Files (anticipated)

- `src/platform/settings/registry.ts` — `image` input type + 2 asset entries.
- `src/platform/branding/assets.ts` (new) + test — service + `readBrandingAsset`.
- `src/app/api/branding/[asset]/route.ts` (new) + test — public serving.
- `src/app/admin/settings/page.tsx` — `image` widget + upload/remove actions.
- `src/platform/ui/haven-logo.tsx` — async, mask → route.
- `src/app/layout.tsx` — favicon in `generateMetadata`.
- `src/app/icon.svg` — deleted.
