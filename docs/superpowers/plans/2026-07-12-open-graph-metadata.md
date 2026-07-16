# Open Graph Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Hub page a branded Open Graph / Twitter card using the Yale Physicians Building photo, plus dynamic per-page titles and descriptions.

**Architecture:** A single async helper `buildPageMetadata()` returns a complete branded `Metadata` object (title template, `metadataBase`, full `openGraph` + `twitter` card, physicians image) so no page relies on Next.js parent-to-child metadata merging. The root and apply layouts, each top-level module layout, and the public login/dashboard pages call it (modules reuse the module registry's own copy).

**Tech Stack:** Next.js App Router Metadata API, `sharp` (image crop, already a dependency), Vitest, settings service (`getSetting`), module registry (`getModule`).

## Global Constraints

- No em-dashes anywhere (copy or comments). The page-title separator is the middle dot `" · "`. An ESLint rule enforces this; a stray em-dash fails lint.
- Never hardcode the app name, org name, or base URL. Always resolve them through `getSetting` (`branding.appName`, `branding.orgName`, `app.baseUrl`).
- Per-module title/description must come from the module registry (`getModule(id)`) to stay DRY with the hub tiles.
- All metadata code runs in server components only (every target file is already a server component).
- OG image: JPEG, exactly 1200x630, committed as a static asset at `public/brand/og-image.jpg`.
- Verification commands: `npm run typecheck`, `npm run lint`, `npm run test` (or a single file via `npx vitest run <path>`). Lint runs before tests in CI, so keep lint clean.

---

### Task 1: Generate the OG image asset

**Files:**
- Create: `public/brand/og-image.jpg` (generated from `public/brand/login-building.webp`, 2500x1178)

- [ ] **Step 1: Generate the 1200x630 JPEG**

Run (from the worktree root):

```bash
node -e "require('sharp')('public/brand/login-building.webp').resize(1200,630,{fit:'cover',position:'centre'}).jpeg({quality:82,mozjpeg:true}).toFile('public/brand/og-image.jpg').then(i=>console.log('wrote',i.width+'x'+i.height,i.size+' bytes'))"
```

Expected: prints `wrote 1200x630 <N> bytes` with N roughly 120000-260000.

- [ ] **Step 2: Verify dimensions and format**

Run:

```bash
node -e "require('sharp')('public/brand/og-image.jpg').metadata().then(m=>console.log(m.width+'x'+m.height,m.format))"
```

Expected: `1200x630 jpeg`

- [ ] **Step 3: Commit**

```bash
git add public/brand/og-image.jpg
git commit -m "feat: add 1200x630 physicians-building OG image"
```

---

### Task 2: The `buildPageMetadata` helper (TDD)

**Files:**
- Create: `src/platform/branding/metadata.ts`
- Test: `src/platform/branding/metadata.test.ts`

**Interfaces:**
- Consumes: `getSetting` from `@/platform/settings/service`; `getModule` from `@/platform/modules/registry`; `public/brand/og-image.jpg` from Task 1.
- Produces:
  - `buildPageMetadata(opts?: { title?: string; description?: string }): Promise<Metadata>`
  - `moduleMetadata(id: string): Promise<Metadata>`

- [ ] **Step 1: Write the failing test**

Create `src/platform/branding/metadata.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const getSetting = vi.fn();
vi.mock("@/platform/settings/service", () => ({
  getSetting: (key: string) => getSetting(key),
}));

import { buildPageMetadata, moduleMetadata } from "./metadata";

beforeEach(() => {
  getSetting.mockReset();
  getSetting.mockImplementation((key: string) => {
    const values: Record<string, unknown> = {
      "branding.appName": "HAVEN Hub",
      "branding.orgName": "HAVEN Free Clinic",
      "app.baseUrl": "https://hub.example.org",
    };
    return Promise.resolve(values[key]);
  });
});

describe("buildPageMetadata", () => {
  it("root call sets a title template and app-name OG title", async () => {
    const m = await buildPageMetadata();
    expect(m.title).toEqual({ default: "HAVEN Hub", template: "%s · HAVEN Hub" });
    expect(m.openGraph?.title).toBe("HAVEN Hub");
    expect(m.description).toBe("The unified platform for HAVEN Hub");
  });

  it("child call composes the OG title and keeps a raw tab title", async () => {
    const m = await buildPageMetadata({ title: "Learning", description: "Courses" });
    expect(m.title).toBe("Learning");
    expect(m.openGraph?.title).toBe("Learning · HAVEN Hub");
    expect(m.twitter?.title).toBe("Learning · HAVEN Hub");
    expect(m.description).toBe("Courses");
  });

  it("resolves metadataBase from app.baseUrl", async () => {
    const m = await buildPageMetadata();
    expect(m.metadataBase?.toString()).toBe("https://hub.example.org/");
  });

  it("uses the 1200x630 physicians JPG for OG and Twitter", async () => {
    const m = await buildPageMetadata();
    const img = (m.openGraph?.images as Array<{ url: string; width: number; height: number }>)[0];
    expect(img).toMatchObject({ url: "/brand/og-image.jpg", width: 1200, height: 630 });
    expect(m.twitter?.card).toBe("summary_large_image");
    expect((m.twitter?.images as string[])[0]).toBe("/brand/og-image.jpg");
  });
});

describe("moduleMetadata", () => {
  it("reuses the module registry title and description", async () => {
    const m = await moduleMetadata("learning");
    expect(m.title).toBe("Learning");
    expect(m.openGraph?.title).toBe("Learning · HAVEN Hub");
    expect(m.description).toBe("Self-paced training courses assigned by department");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/branding/metadata.test.ts`
Expected: FAIL (cannot resolve `./metadata`).

- [ ] **Step 3: Write the helper**

Create `src/platform/branding/metadata.ts`:

```ts
import type { Metadata } from "next";
import { getSetting } from "@/platform/settings/service";
import { getModule } from "@/platform/modules/registry";

const OG_IMAGE_PATH = "/brand/og-image.jpg";
const OG_IMAGE_WIDTH = 1200;
const OG_IMAGE_HEIGHT = 630;
const SEP = " · ";

/**
 * Builds a complete, branded Metadata object (Open Graph + Twitter card) for any
 * page. Returning a full card on every call, rather than relying on Next.js
 * parent-to-child metadata merging, avoids the gotcha where a child segment that
 * defines `openGraph` silently drops the parent's `openGraph.images`.
 *
 * Root pages call this with no title: the title becomes a template so child pages
 * that set a plain-string title read "<Page> · <appName>" in the browser tab.
 * Child pages pass a title; the Open Graph title is composed the same way.
 */
export async function buildPageMetadata(
  opts: { title?: string; description?: string } = {},
): Promise<Metadata> {
  const [appName, orgName, baseUrl] = await Promise.all([
    getSetting<string>("branding.appName"),
    getSetting<string>("branding.orgName"),
    getSetting<string>("app.baseUrl"),
  ]);

  const description = opts.description ?? `The unified platform for ${appName}`;
  const ogTitle = opts.title ? `${opts.title}${SEP}${appName}` : appName;

  return {
    metadataBase: new URL(baseUrl),
    title: opts.title ?? { default: appName, template: `%s${SEP}${appName}` },
    description,
    openGraph: {
      title: ogTitle,
      description,
      siteName: appName,
      type: "website",
      images: [
        { url: OG_IMAGE_PATH, width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT, alt: orgName },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: ogTitle,
      description,
      images: [OG_IMAGE_PATH],
    },
  };
}

/** Metadata for a top-level module, reusing the module registry's own copy. */
export function moduleMetadata(id: string): Promise<Metadata> {
  const mod = getModule(id);
  return buildPageMetadata({ title: mod?.title, description: mod?.description });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/branding/metadata.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/branding/metadata.ts src/platform/branding/metadata.test.ts
git commit -m "feat: add buildPageMetadata branded-card helper"
```

---

### Task 3: Wire the root and apply layouts

**Files:**
- Modify: `src/app/layout.tsx:22-32` (the `generateMetadata` function)
- Modify: `src/app/apply/layout.tsx:14-20` (the `generateMetadata` function)

**Interfaces:**
- Consumes: `buildPageMetadata` from Task 2.

- [ ] **Step 1: Update the root layout**

In `src/app/layout.tsx`, add the import near the other `@/platform` imports:

```ts
import { buildPageMetadata } from "@/platform/branding/metadata";
```

Replace the existing `generateMetadata` (lines 22-32) with:

```ts
export async function generateMetadata(): Promise<Metadata> {
  const [base, favicon] = await Promise.all([
    buildPageMetadata(),
    getSetting<{ contentType: string; version: number }>("branding.favicon"),
  ]);
  return { ...base, icons: { icon: `/api/branding/favicon?v=${favicon.version}` } };
}
```

(The existing `getSetting` and `Metadata` imports stay; the `branding.appName` fetch moves into the helper. Favicon behavior is preserved.)

- [ ] **Step 2: Update the apply layout**

In `src/app/apply/layout.tsx`, replace the whole `generateMetadata` (lines 14-20) with:

```ts
export async function generateMetadata(): Promise<Metadata> {
  const [title, orgName] = await Promise.all([
    getSetting<string>("branding.applyPortalTitle"),
    getSetting<string>("branding.orgName"),
  ]);
  return buildPageMetadata({ title, description: `Apply to ${orgName}` });
}
```

Add the import at the top:

```ts
import { buildPageMetadata } from "@/platform/branding/metadata";
```

Note: `buildPageMetadata` prepends the app name to the tab title via the root template, so the apply tab reads "<applyPortalTitle> · <appName>". If the product wants the apply portal title to stand alone (no app-name suffix), that is a copy decision to raise with the user, not a blocker.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/layout.tsx src/app/apply/layout.tsx
git commit -m "feat: brand root and apply metadata via buildPageMetadata"
```

---

### Task 4: Per-module metadata (registry-driven)

**Files:**
- Modify (add `generateMetadata` + import): `src/app/(app)/schedule/layout.tsx`, `src/app/(app)/volunteers/layout.tsx`, `src/app/(app)/incidents/layout.tsx`, `src/app/(app)/clinic/layout.tsx`, `src/app/(app)/admin/layout.tsx`, `src/app/(app)/recruitment/layout.tsx`, `src/app/(app)/learning/layout.tsx`, `src/app/(app)/support/layout.tsx`
- Create: `src/app/(app)/my-info/layout.tsx`
- Create: `src/app/(app)/notifications/layout.tsx`

**Interfaces:**
- Consumes: `moduleMetadata` and `buildPageMetadata` from Task 2.

- [ ] **Step 1: Add module metadata to the eight existing layouts**

For each of the eight layouts, add the import (with the other imports at the top) and the export (directly under the imports, before the default component). Use the module id matching the folder name.

Import line (identical in all eight):

```ts
import { moduleMetadata } from "@/platform/branding/metadata";
```

Export, one per file, using that folder's module id:

```ts
// schedule/layout.tsx
export function generateMetadata() {
  return moduleMetadata("schedule");
}
```

Repeat with the correct id for the rest: `volunteers`, `incidents`, `clinic`, `admin`, `recruitment`, `learning`, `support`. (These ids all exist in `src/platform/modules/registry.ts`.)

- [ ] **Step 2: Create the My Info passthrough layout**

Create `src/app/(app)/my-info/layout.tsx`:

```ts
import type { ReactNode } from "react";
import { moduleMetadata } from "@/platform/branding/metadata";

export function generateMetadata() {
  return moduleMetadata("my-info");
}

export default function MyInfoLayout({ children }: { children: ReactNode }) {
  return children;
}
```

- [ ] **Step 3: Create the Notifications passthrough layout**

Notifications is not a hub-tile module (no registry entry), so use literal copy:

Create `src/app/(app)/notifications/layout.tsx`:

```ts
import type { ReactNode } from "react";
import { buildPageMetadata } from "@/platform/branding/metadata";

export function generateMetadata() {
  return buildPageMetadata({ title: "Notifications", description: "Your notification inbox" });
}

export default function NotificationsLayout({ children }: { children: ReactNode }) {
  return children;
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)"
git commit -m "feat: per-module Open Graph metadata from the module registry"
```

---

### Task 5: Home (dashboard) and public login metadata

**Files:**
- Modify: `src/app/(app)/page.tsx` (add `generateMetadata`)
- Modify: `src/app/login/page.tsx` (add `generateMetadata`)

**Interfaces:**
- Consumes: `buildPageMetadata` from Task 2.

- [ ] **Step 1: Add dashboard metadata**

In `src/app/(app)/page.tsx`, add the import with the other imports:

```ts
import { buildPageMetadata } from "@/platform/branding/metadata";
```

Add, above the default page component:

```ts
export function generateMetadata() {
  return buildPageMetadata({ title: "Dashboard" });
}
```

- [ ] **Step 2: Add login metadata**

In `src/app/login/page.tsx`, add the import with the other imports:

```ts
import { buildPageMetadata } from "@/platform/branding/metadata";
```

Add, above the default page component:

```ts
export function generateMetadata() {
  return buildPageMetadata({ title: "Sign in" });
}
```

(Description falls back to the default "The unified platform for <appName>". Login already has no `generateMetadata`, so nothing is overwritten.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/page.tsx" src/app/login/page.tsx
git commit -m "feat: dashboard and login page metadata"
```

---

### Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole project**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Lint (catches any em-dash and purity violations)**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Run the new helper test**

Run: `npx vitest run src/platform/branding/metadata.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 4: Runtime confirmation (deferred to preview)**

The Hub's `getSetting` reads from the database at runtime, and this worktree has no local database (the repo `.env` points at shared Neon, which must not be touched). So confirm the rendered tags on a Vercel preview deploy of this branch (previews share the prod DB and have real branding settings): view source on `/login` and check for `og:image` (points at `/brand/og-image.jpg`), `og:title`, `og:site_name`, and `twitter:card` = `summary_large_image`. Paste the preview `/login` URL into a Slack or Teams message to see the unfurled card with the physicians image.

This step has no local command; record the preview URL and the observed tags when available.

---

## Notes for the implementer

- Do not run the full `npm run test` suite in this worktree unless a per-worktree `TEST_DATABASE_URL` is set: worktrees sharing the local `havenhub_test` database can deadlock, and the repo `.env` DB URLs point at shared Neon. The one new test mocks `getSetting`, so run it in isolation as shown.
- Every target layout and page was verified to be a server component (no `"use client"`), which is why each can export `generateMetadata`.
