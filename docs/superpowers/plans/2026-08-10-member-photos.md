# Member Photos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every member a profile photo, auto-sourced from the Yalies API for Yale College students and self-uploaded by everyone else, shown in the account menu, admin people views, and the public credential page.

**Architecture:** Seven additive columns on `Person` hold the photo state. A new `src/platform/photos/` module owns all reads and writes; it is platform-level rather than a module because `/my-info`, admin, and passport all consume it and eslint forbids modules from importing each other. Two image routes serve bytes: an authenticated one that lazily self-heals by calling Yalies on a miss, and a public one keyed on the credential token that never calls Yalies.

**Tech Stack:** Next.js App Router, Prisma + Postgres, Cloudflare R2 via `@/platform/storage`, sharp for image normalization, vitest for tests.

**Spec:** `docs/superpowers/specs/2026-08-10-member-photos-design.md`

## Global Constraints

- **No em-dashes anywhere.** CI enforces the `local/no-em-dash` eslint rule. This includes comments, strings, and docs.
- **Lint with `npx eslint src e2e`**, not `npm run lint`. The bare command walks a gitignored design-system directory and reports noise.
- **Read test results by the pass/fail counts, not the exit code.** Piping vitest through `tail` returns 0 even on a failed suite.
- **Test database:** run `npm run test:prepare` once before DB-backed tests. It uses `TEST_DATABASE_URL`, defaulting to `postgresql://haven:haven_dev@localhost:5434/havenhub_test`.
- **`prisma migrate dev` folds pre-existing drift into your migration.** After generating, open the SQL and delete anything your change did not cause.
- **Photo size is 512x512 WebP.** Referenced by name as `PHOTO_SIZE` from Task 2 onward.
- **`photoSource` values are the exact strings `"yalies"` and `"upload"`.**
- **Never log `YALIES_API_KEY`,** and never call the Yalies API over plain HTTP. Their documented policy is immediate key revocation.
- **Client components import `@/platform/photos/shared`, never `@/platform/photos`.** The barrel re-exports sharp and Prisma; `shared.ts` imports nothing. `src/platform/ui/account-menu.tsx` is a `"use client"` file, so this rule is load-bearing, not stylistic.
- **Test commands need the worktree's own database**, because the repo `.env` points every database URL at production Neon. Prefix every test run with:
  `TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_member_photos" BLOB_READ_WRITE_TOKEN=""`
- **`UPLOAD_DIR` is a single shared `/tmp` path across all worktrees.** If a storage-touching test fails with ENOENT on a file another test wrote, that is the known shared-directory collision, not your code. Re-run the file alone before investigating.

---

### Task 1: Schema columns and config

**Files:**
- Modify: `prisma/schema.prisma` (the `Person` model, around line 111)
- Modify: `src/platform/config.ts` (server env block, near the R2 vars around line 76)
- Create: `prisma/migrations/<timestamp>_add_person_photo/migration.sql` (generated)

**Interfaces:**
- Consumes: nothing
- Produces: `Person.photoKey`, `Person.photoSource`, `Person.photoVersion`, `Person.photoUpdatedAt`, `Person.photoSuppressed`, `Person.photoSyncedAt`, `Person.photoSyncMisses`; `config.YALIES_API_KEY: string | undefined`

- [ ] **Step 1: Add the columns to the Person model**

In `prisma/schema.prisma`, inside `model Person`, after the `gradYear` field:

```prisma
  /// Profile photo state. Bytes live in object storage under the fixed key
  /// "people/<personId>"; photoKey is null when the person has no photo.
  /// Auto-sourced from Yalies for Yale College students, or self-uploaded.
  photoKey                       String?
  /// "yalies" (auto-sourced) or "upload" (member or admin supplied). Decides
  /// whether removing the photo suppresses future Yalies pulls.
  photoSource                    String?
  /// Monotonic cache-buster for the ?v= query param on both photo routes.
  /// NEVER reset on removal: reusing a version pins browsers to a stale image
  /// (the same trap documented in platform/branding/assets.ts).
  photoVersion                   Int                        @default(0)
  photoUpdatedAt                 DateTime?
  /// Set by removing a Yalies-sourced photo, meaning "do not use my Yale photo".
  /// Cleared by any upload. Removing a self-uploaded photo does NOT set it.
  photoSuppressed                Boolean                    @default(false)
  /// Last Yalies attempt, success or miss. Null means never attempted.
  photoSyncedAt                  DateTime?
  /// Consecutive misses, driving the retry backoff. Reset to 0 on success.
  photoSyncMisses                Int                        @default(0)
```

- [ ] **Step 2: Add the API key to config**

In `src/platform/config.ts`, immediately after the `R2_BUCKET` line:

```ts
    // Yalies API key (https://yalies.io/api), used to auto-source Yale College
    // profile photos by netId. Optional: when unset, photo auto-sourcing is
    // inert and only self-uploaded photos exist. Server-only, never logged.
    // Requests MUST use https; Yalies revokes keys used over plain HTTP.
    YALIES_API_KEY: z.string().optional(),
```

- [ ] **Step 3: Generate the migration**

Run: `npm run db:up && npx prisma migrate dev --name add_person_photo`

- [ ] **Step 4: Trim the migration SQL**

Open the generated `prisma/migrations/<timestamp>_add_person_photo/migration.sql`. It must contain only `ALTER TABLE "Person" ADD COLUMN` statements for the seven columns above. Delete any other statement: `prisma migrate dev` folds pre-existing schema drift into whatever migration you happen to be generating.

- [ ] **Step 5: Verify the schema applies cleanly**

Run: `npm run test:prepare && npx tsc --noEmit`
Expected: migration applies, typecheck passes.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/platform/config.ts
git commit -m "feat(photos): add Person photo columns and YALIES_API_KEY config"
```

---

### Task 2: Image normalization

**Files:**
- Create: `src/platform/photos/shared.ts`
- Create: `src/platform/photos/normalize.ts`
- Create: `src/platform/photos/normalize.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces, from `shared.ts`: `PHOTO_SIZE: 512`, `PHOTO_CONTENT_TYPE: "image/webp"`, `class PhotoError extends Error`, `photoUrl(person: { id: string; photoVersion: number }): string`
- Produces, from `normalize.ts`: `normalizePhoto(input: Buffer): Promise<Buffer>`

**Why `shared.ts` exists.** `src/platform/ui/account-menu.tsx` is a `"use client"` component, and Task 9 renders a photo inside it. Anything a client component imports gets bundled for the browser. `normalize.ts` imports sharp and `service.ts` imports Prisma, so a client component that reaches either (directly or through the `index.ts` barrel) drags a native image library and a database client into the browser bundle. `shared.ts` holds exactly the values both sides need and imports nothing at all, so client components can import it safely. **Client components must import `@/platform/photos/shared`, never `@/platform/photos`.**

- [ ] **Step 1: Write the failing tests**

Create `src/platform/photos/normalize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { normalizePhoto } from "./normalize";
import { PHOTO_SIZE, PhotoError } from "./shared";

/** A solid-colour test image of the given dimensions. */
async function image(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
}

describe("normalizePhoto", () => {
  it("produces a square WebP at PHOTO_SIZE from a landscape source", async () => {
    const out = await normalizePhoto(await image(1200, 600));
    const meta = await sharp(out).metadata();

    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(PHOTO_SIZE);
    expect(meta.height).toBe(PHOTO_SIZE);
  });

  it("produces a square WebP at PHOTO_SIZE from a portrait source", async () => {
    const out = await normalizePhoto(await image(600, 1200));
    const meta = await sharp(out).metadata();

    expect(meta.width).toBe(PHOTO_SIZE);
    expect(meta.height).toBe(PHOTO_SIZE);
  });

  it("upscales a source smaller than PHOTO_SIZE", async () => {
    const out = await normalizePhoto(await image(64, 64));
    const meta = await sharp(out).metadata();

    expect(meta.width).toBe(PHOTO_SIZE);
    expect(meta.height).toBe(PHOTO_SIZE);
  });

  it("strips EXIF metadata", async () => {
    const withExif = await sharp(await image(800, 800))
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const meta = await sharp(await normalizePhoto(withExif)).metadata();

    expect(meta.orientation).toBeUndefined();
  });

  it("throws PhotoError on bytes that are not an image", async () => {
    await expect(normalizePhoto(Buffer.from("this is not an image"))).rejects.toBeInstanceOf(
      PhotoError
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/platform/photos/normalize.test.ts`
Expected: FAIL, cannot resolve `./normalize`.

- [ ] **Step 3: Write the shared leaf module**

Create `src/platform/photos/shared.ts`. It must import nothing, so client components can use it without pulling sharp or Prisma into the browser bundle:

```ts
/**
 * Photo values shared by server and client code.
 *
 * This module imports NOTHING on purpose. normalize.ts pulls in sharp and
 * service.ts pulls in Prisma, so any client component reaching those (or the
 * index.ts barrel that re-exports them) would bundle a native image library and
 * a database client into the browser. Client components import this file
 * directly instead.
 */

/** Stored photos are square at this edge length, in pixels. */
export const PHOTO_SIZE = 512;

/** Every stored photo is WebP, regardless of what came in. */
export const PHOTO_CONTENT_TYPE = "image/webp";

/** Thrown when bytes cannot be decoded, or an upload fails validation. */
export class PhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoError";
  }
}

/**
 * The versioned URL an in-app <img> points at.
 *
 * The ?v= parameter is what makes the route's long immutable cache safe: it
 * changes on every photo set and every removal.
 */
export function photoUrl(person: { id: string; photoVersion: number }): string {
  return `/api/people/${person.id}/photo?v=${person.photoVersion}`;
}
```

- [ ] **Step 4: Write the implementation**

Create `src/platform/photos/normalize.ts`:

```ts
/**
 * Normalization for member profile photos.
 *
 * Every photo reaching storage goes through here, whether auto-sourced from
 * Yalies or uploaded by a member, so the badge and the public credential page
 * can assume one square size and one content type.
 *
 * Stripping EXIF is not only hygiene: an uploaded phone photo carries
 * orientation (which would render sideways without .rotate()) and often GPS
 * coordinates, which have no business on a public credential page.
 */
import sharp from "sharp";
import { PHOTO_SIZE, PhotoError } from "./shared";

/**
 * Decode, auto-orient, centre-crop square, resize, and re-encode as WebP.
 *
 * .rotate() with no argument applies the EXIF orientation tag and then drops
 * it. sharp does not carry metadata to the output unless asked, so the result
 * has no EXIF at all.
 */
export async function normalizePhoto(input: Buffer): Promise<Buffer> {
  try {
    return await sharp(input)
      .rotate()
      .resize(PHOTO_SIZE, PHOTO_SIZE, { fit: "cover", position: "centre" })
      .webp({ quality: 82 })
      .toBuffer();
  } catch (err) {
    throw new PhotoError(
      `Could not read that image. Use a PNG, JPEG, or WebP file. (${
        err instanceof Error ? err.message : "unknown error"
      })`
    );
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/platform/photos/normalize.test.ts`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add src/platform/photos/shared.ts src/platform/photos/normalize.ts src/platform/photos/normalize.test.ts
git commit -m "feat(photos): normalize photos to 512px square WebP with EXIF stripped"
```

---

### Task 3: Yalies API client

**Files:**
- Create: `src/platform/photos/yalies.ts`
- Create: `src/platform/photos/yalies.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `isYaliesEnabled(): boolean`, `fetchYaliesPhoto(netId: string): Promise<Buffer | null>`, `YALIES_TIMEOUT_MS: 2000`

This client never throws and never retries. Every failure mode returns `null`, which `service.ts` records as a miss. Retry policy is the service's job, not the client's.

- [ ] **Step 1: Write the failing tests**

Create `src/platform/photos/yalies.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchYaliesPhoto } from "./yalies";

vi.mock("@/platform/config", () => ({ config: { YALIES_API_KEY: "test-key" } }));

/** A PNG byte response the image fetch can return. */
function imageResponse(): Response {
  return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

const PHOTO_URL = "https://yalestudentphotos.s3.amazonaws.com/abc.jpg";

describe("fetchYaliesPhoto", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns bytes when Yalies has a photo", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce(imageResponse());

    const bytes = await fetchYaliesPhoto("abc12");

    expect(bytes).toBeInstanceOf(Buffer);
  });

  it("sends the netid filter and a bearer token over https", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce(imageResponse());

    await fetchYaliesPhoto("abc12");

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe("https://api.yalies.io/v2/people");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(init?.body))).toEqual({ filters: { netid: ["abc12"] } });
  });

  it("returns null when the person has no image", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([{ netid: "abc12", image: null }]));

    expect(await fetchYaliesPhoto("abc12")).toBeNull();
  });

  it("returns null when nobody matches the netid", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([]));

    expect(await fetchYaliesPhoto("nope99")).toBeNull();
  });

  it("returns null when the API errors", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("nope", { status: 500 }));

    expect(await fetchYaliesPhoto("abc12")).toBeNull();
  });

  it("returns null when the API is unreachable", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    expect(await fetchYaliesPhoto("abc12")).toBeNull();
  });

  it("returns null when the image object is gone", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce(new Response("gone", { status: 404 }));

    expect(await fetchYaliesPhoto("abc12")).toBeNull();
  });

  it("refuses an image URL on an unexpected host", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json([{ netid: "abc12", image: "http://169.254.169.254/latest/meta-data/" }])
    );

    expect(await fetchYaliesPhoto("abc12")).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("refuses a response that is not an image", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce(
        new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })
      );

    expect(await fetchYaliesPhoto("abc12")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/platform/photos/yalies.test.ts`
Expected: FAIL, cannot resolve `./yalies`.

- [ ] **Step 3: Write the implementation**

Create `src/platform/photos/yalies.ts`:

```ts
/**
 * Yalies API client, narrowed to one job: netId to photo bytes.
 *
 * Yalies (https://yalies.io) is a Yale Computer Society project that scrapes the
 * Yale Face Book and Directory. It publishes no rate limit, uptime commitment,
 * or terms of use, so this client treats it as unreliable by default: one
 * attempt, a hard timeout, and null on every failure. Retry policy lives in
 * service.ts, which has the state to back it off.
 *
 * Photos exist for Yale College students only. The Face Book scrape is the sole
 * source of the `image` field, so anyone sourced from the Directory instead
 * (medicine, nursing, public health, graduate, staff) always returns null here.
 */
import { config } from "@/platform/config";

const API_URL = "https://api.yalies.io/v2/people";

/**
 * Yalies re-hosts scraped Face Book photos in one S3 bucket. Pinning the host
 * means a compromised or buggy API response cannot point our server-side fetch
 * at an arbitrary address, including cloud metadata endpoints.
 */
const PHOTO_HOST = "yalestudentphotos.s3.amazonaws.com";

/** One attempt gets 2 seconds. A slow Yalies must never become a slow page. */
export const YALIES_TIMEOUT_MS = 2000;

/** True when an API key is configured. Without one, auto-sourcing is inert. */
export function isYaliesEnabled(): boolean {
  return Boolean(config.YALIES_API_KEY);
}

/** The photo URL if this response body carries a usable one, else null. */
function photoUrlFrom(body: unknown): string | null {
  if (!Array.isArray(body) || body.length === 0) return null;
  const image = (body[0] as { image?: unknown }).image;
  if (typeof image !== "string" || image === "") return null;

  let parsed: URL;
  try {
    parsed = new URL(image);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== PHOTO_HOST) return null;
  return parsed.toString();
}

/**
 * Photo bytes for a netId, or null when there is no photo to be had.
 *
 * Null covers every failure: no API key, no match, no image on the record, a
 * non-2xx from either hop, an unexpected host, a non-image body, a timeout, and
 * an unreachable host. Callers cannot distinguish them and should not try.
 */
export async function fetchYaliesPhoto(netId: string): Promise<Buffer | null> {
  if (!config.YALIES_API_KEY) return null;

  try {
    const lookup = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.YALIES_API_KEY}`,
      },
      body: JSON.stringify({ filters: { netid: [netId] } }),
      signal: AbortSignal.timeout(YALIES_TIMEOUT_MS),
    });
    if (!lookup.ok) return null;

    const url = photoUrlFrom(await lookup.json());
    if (!url) return null;

    const image = await fetch(url, { signal: AbortSignal.timeout(YALIES_TIMEOUT_MS) });
    if (!image.ok) return null;
    if (!(image.headers.get("content-type") ?? "").startsWith("image/")) return null;

    return Buffer.from(await image.arrayBuffer());
  } catch {
    // Timeout, DNS failure, connection reset, malformed JSON. All are misses.
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/platform/photos/yalies.test.ts`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add src/platform/photos/yalies.ts src/platform/photos/yalies.test.ts
git commit -m "feat(photos): add Yalies API client with timeout and host pinning"
```

---

### Task 4: Initials fallback

**Files:**
- Create: `src/platform/photos/initials.ts`
- Create: `src/platform/photos/initials.test.ts`

**Interfaces:**
- Consumes: `PHOTO_SIZE` (Task 2, from `./shared`)
- Produces: `toInitials(name: string | null): string`, `initialsSvg(name: string | null): string`

`initials.ts` must import only from `./shared`, never from `./normalize` or `./service`, so it stays free of sharp and Prisma.

`toInitials` is lifted from `src/platform/ui/account-menu.tsx`, preserving its existing behaviour exactly, including the middle-dot `"·"` placeholder for a missing name. Do not change it to `"?"`: that dot is what ships today. Task 9 deletes the copy in `account-menu.tsx`, which stops using it entirely.

- [ ] **Step 1: Write the failing tests**

Create `src/platform/photos/initials.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { initialsSvg, toInitials } from "./initials";

describe("toInitials", () => {
  it("takes the first and last name initials", () => {
    expect(toInitials("Ada Lovelace")).toBe("AL");
  });

  it("handles a single name", () => {
    expect(toInitials("Ada")).toBe("A");
  });

  it("skips middle names", () => {
    expect(toInitials("Ada Byron King Lovelace")).toBe("AL");
  });

  it("returns the middle-dot placeholder for null", () => {
    expect(toInitials(null)).toBe("·");
  });

  it("returns the middle-dot placeholder for an empty or whitespace name", () => {
    expect(toInitials("   ")).toBe("·");
  });
});

describe("initialsSvg", () => {
  it("renders the initials into the SVG", () => {
    expect(initialsSvg("Ada Lovelace")).toContain(">AL<");
  });

  it("is a well-formed standalone SVG", () => {
    const svg = initialsSvg("Ada Lovelace");

    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("gives different names different backgrounds", () => {
    expect(initialsSvg("Ada Lovelace")).not.toBe(initialsSvg("Grace Hopper"));
  });

  it("gives the same name the same background every time", () => {
    expect(initialsSvg("Ada Lovelace")).toBe(initialsSvg("Ada Lovelace"));
  });

  it("escapes characters that would break the markup", () => {
    expect(initialsSvg("<script> Bad")).not.toContain("<script>");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/platform/photos/initials.test.ts`
Expected: FAIL, cannot resolve `./initials`.

- [ ] **Step 3: Write the implementation**

Create `src/platform/photos/initials.ts`:

```ts
/**
 * The initials placeholder shown wherever a person has no photo.
 *
 * Rendered server-side as an SVG by the photo routes rather than in the client,
 * so <PersonPhoto> needs no fallback branch: it points an <img> at the route and
 * gets either a photo or this, with the same dimensions either way.
 */
import { PHOTO_SIZE } from "./shared";

/** Background hues, spaced around the wheel so adjacent names look distinct. */
const HUES = [210, 340, 150, 30, 265, 190, 95, 15];

/** Initials for a name: first and last word, uppercased. "·" when unusable. */
export function toInitials(name: string | null): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "·";
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return `${first}${last}`.toUpperCase();
}

/** Stable hue for a name, so a person's placeholder never changes colour. */
function hueFor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) % 100000;
  }
  return HUES[hash % HUES.length];
}

/** Escape the five XML metacharacters so a name cannot break out of the markup. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A square SVG placeholder carrying the person's initials. */
export function initialsSvg(name: string | null): string {
  const initials = escapeXml(toInitials(name));
  const hue = hueFor(name ?? "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PHOTO_SIZE}" height="${PHOTO_SIZE}" viewBox="0 0 ${PHOTO_SIZE} ${PHOTO_SIZE}" role="img"><rect width="${PHOTO_SIZE}" height="${PHOTO_SIZE}" fill="hsl(${hue} 45% 35%)"/><text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${Math.round(PHOTO_SIZE * 0.4)}" font-weight="600" fill="#ffffff">${initials}</text></svg>`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/platform/photos/initials.test.ts`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add src/platform/photos/initials.ts src/platform/photos/initials.test.ts
git commit -m "feat(photos): add initials SVG placeholder"
```

---

### Task 5: Pull predicate and backoff

**Files:**
- Create: `src/platform/photos/policy.ts`
- Create: `src/platform/photos/policy.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `type PhotoState`, `backoffMs(misses: number): number`, `shouldAttemptYaliesPull(person: PhotoState, now: Date): boolean`

Pure functions, no DB and no clock reads. `now` is a required parameter: the project forbids `Date.now()` in render paths, and injecting it makes the backoff table testable.

- [ ] **Step 1: Write the failing tests**

Create `src/platform/photos/policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { backoffMs, shouldAttemptYaliesPull, type PhotoState } from "./policy";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-10T12:00:00Z");

/** A person who passes every condition, so each test can break exactly one. */
function eligible(overrides: Partial<PhotoState> = {}): PhotoState {
  return {
    netId: "abc12",
    yaleAffiliation: "yale_college",
    photoKey: null,
    photoSuppressed: false,
    photoSyncedAt: null,
    photoSyncMisses: 0,
    ...overrides,
  };
}

describe("backoffMs", () => {
  it("waits a day after the first miss", () => {
    expect(backoffMs(1)).toBe(1 * DAY);
  });

  it("waits a week after the second", () => {
    expect(backoffMs(2)).toBe(7 * DAY);
  });

  it("waits a month after the third", () => {
    expect(backoffMs(3)).toBe(30 * DAY);
  });

  it("caps at a month thereafter", () => {
    expect(backoffMs(4)).toBe(30 * DAY);
    expect(backoffMs(99)).toBe(30 * DAY);
  });
});

describe("shouldAttemptYaliesPull", () => {
  it("attempts for an eligible person never synced before", () => {
    expect(shouldAttemptYaliesPull(eligible(), NOW)).toBe(true);
  });

  it("refuses when a photo already exists", () => {
    expect(shouldAttemptYaliesPull(eligible({ photoKey: "people/p1" }), NOW)).toBe(false);
  });

  it("refuses when suppressed", () => {
    expect(shouldAttemptYaliesPull(eligible({ photoSuppressed: true }), NOW)).toBe(false);
  });

  it("refuses without a netId", () => {
    expect(shouldAttemptYaliesPull(eligible({ netId: null }), NOW)).toBe(false);
  });

  it("refuses for a non-Yale affiliation", () => {
    expect(shouldAttemptYaliesPull(eligible({ yaleAffiliation: "non_yale" }), NOW)).toBe(false);
  });

  it("attempts for an unknown affiliation, which is worth one try", () => {
    expect(shouldAttemptYaliesPull(eligible({ yaleAffiliation: null }), NOW)).toBe(true);
  });

  it("attempts for a non-Yale-College Yale affiliation, which is worth one try", () => {
    expect(shouldAttemptYaliesPull(eligible({ yaleAffiliation: "ysm_md" }), NOW)).toBe(true);
  });

  it("refuses inside the backoff window", () => {
    const person = eligible({
      photoSyncMisses: 1,
      photoSyncedAt: new Date(NOW.getTime() - 12 * 60 * 60 * 1000),
    });

    expect(shouldAttemptYaliesPull(person, NOW)).toBe(false);
  });

  it("attempts once the backoff window has elapsed", () => {
    const person = eligible({
      photoSyncMisses: 1,
      photoSyncedAt: new Date(NOW.getTime() - 2 * DAY),
    });

    expect(shouldAttemptYaliesPull(person, NOW)).toBe(true);
  });

  it("still refuses a long-missed person inside the capped window", () => {
    const person = eligible({
      photoSyncMisses: 50,
      photoSyncedAt: new Date(NOW.getTime() - 10 * DAY),
    });

    expect(shouldAttemptYaliesPull(person, NOW)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/platform/photos/policy.test.ts`
Expected: FAIL, cannot resolve `./policy`.

- [ ] **Step 3: Write the implementation**

Create `src/platform/photos/policy.ts`:

```ts
/**
 * When to ask Yalies for a person's photo.
 *
 * Photos are fetched lazily, on view, rather than by a scheduled sweep. That
 * makes the backoff load-bearing rather than a nicety: most of the roster is not
 * in the Yale Face Book at all (medicine, nursing, public health, graduate,
 * staff), and without a backoff every page view for every one of those people
 * would call Yalies. With it, a photoless person costs about one call a month.
 */

/** The subset of Person this policy reads. */
export type PhotoState = {
  netId: string | null;
  yaleAffiliation: string | null;
  photoKey: string | null;
  photoSuppressed: boolean;
  photoSyncedAt: Date | null;
  photoSyncMisses: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Wait after the Nth consecutive miss, in days. The last entry repeats forever. */
const BACKOFF_DAYS = [1, 7, 30];

/** How long to wait after `misses` consecutive misses before asking again. */
export function backoffMs(misses: number): number {
  const index = Math.min(Math.max(misses - 1, 0), BACKOFF_DAYS.length - 1);
  return BACKOFF_DAYS[index] * DAY_MS;
}

/**
 * True when it is worth asking Yalies about this person right now.
 *
 * `now` is injected rather than read: the project's lint rules forbid clock
 * reads in render paths, and a passed clock makes the backoff table testable.
 */
export function shouldAttemptYaliesPull(person: PhotoState, now: Date): boolean {
  if (person.photoKey) return false;
  if (person.photoSuppressed) return false;
  if (!person.netId) return false;
  // Only a declared non-affiliate is excluded outright. An unknown or
  // non-college Yale affiliation still gets one attempt, because the column is
  // self-reported and can be stale or wrong; the backoff absorbs the misses.
  if (person.yaleAffiliation === "non_yale") return false;
  if (!person.photoSyncedAt) return true;
  return now.getTime() - person.photoSyncedAt.getTime() >= backoffMs(person.photoSyncMisses);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/platform/photos/policy.test.ts`
Expected: 15 passed.

- [ ] **Step 5: Commit**

```bash
git add src/platform/photos/policy.ts src/platform/photos/policy.test.ts
git commit -m "feat(photos): add Yalies pull predicate and retry backoff"
```

---

### Task 6: Photo service

**Files:**
- Create: `src/platform/photos/service.ts`
- Create: `src/platform/photos/service.test.ts`
- Create: `src/platform/photos/index.ts`

**Interfaces:**
- Consumes: `normalizePhoto`, `PHOTO_CONTENT_TYPE`, `PhotoError` (Task 2); `fetchYaliesPhoto`, `isYaliesEnabled` (Task 3); `shouldAttemptYaliesPull` (Task 5)
- Produces:
  - `type ResolvedPhoto = { bytes: Buffer; contentType: string } | null`
  - `resolvePhoto(personId: string, now?: Date): Promise<ResolvedPhoto>`
  - `setPhotoFromUpload(personId: string, file: { type: string; size: number; bytes: Buffer }, maxMb: number): Promise<void>`
  - `removePhoto(personId: string): Promise<void>`
  - `photoUrl(person: { id: string; photoVersion: number }): string`
  - `ACCEPTED_UPLOAD_TYPES: Set<string>`

This is the only writer of the seven photo columns.

- [ ] **Step 1: Write the failing tests**

Create `src/platform/photos/service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { getObject } from "@/platform/storage";
import { PhotoError } from "./normalize";
import { removePhoto, resolvePhoto, setPhotoFromUpload } from "./service";

vi.mock("./yalies", () => ({
  isYaliesEnabled: vi.fn(() => true),
  fetchYaliesPhoto: vi.fn(async () => null),
}));

import { fetchYaliesPhoto, isYaliesEnabled } from "./yalies";

/** Real PNG bytes, so normalizePhoto has something it can actually decode. */
async function pngBytes(): Promise<Buffer> {
  return sharp({
    create: { width: 800, height: 800, channels: 3, background: { r: 5, g: 5, b: 5 } },
  })
    .png()
    .toBuffer();
}

async function seedPerson(overrides: Record<string, unknown> = {}) {
  return prisma.person.create({
    data: { name: "Ada Lovelace", netId: "abc12", yaleAffiliation: "yale_college", ...overrides },
  });
}

describe("resolvePhoto", () => {
  beforeEach(async () => {
    await resetDb();
    // mockReturnValue survives clearAllMocks, so re-arm both every test.
    vi.mocked(isYaliesEnabled).mockReturnValue(true);
    vi.mocked(fetchYaliesPhoto).mockResolvedValue(null);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("stores and returns a photo when Yalies has one", async () => {
    vi.mocked(fetchYaliesPhoto).mockResolvedValue(await pngBytes());
    const person = await seedPerson();

    const resolved = await resolvePhoto(person.id);

    expect(resolved?.contentType).toBe("image/webp");
    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoKey).toBe(`people/${person.id}`);
    expect(after.photoSource).toBe("yalies");
    expect(after.photoVersion).toBe(1);
    expect(after.photoSyncMisses).toBe(0);
    expect(await getObject(`people/${person.id}`)).not.toBeNull();
  });

  it("records a miss and returns null when Yalies has nothing", async () => {
    const person = await seedPerson();

    expect(await resolvePhoto(person.id)).toBeNull();

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoKey).toBeNull();
    expect(after.photoSyncMisses).toBe(1);
    expect(after.photoSyncedAt).not.toBeNull();
  });

  it("does not call Yalies again inside the backoff window", async () => {
    const person = await seedPerson({ photoSyncMisses: 1, photoSyncedAt: new Date() });

    await resolvePhoto(person.id);

    expect(vi.mocked(fetchYaliesPhoto)).not.toHaveBeenCalled();
  });

  it("serves the stored photo without calling Yalies", async () => {
    const person = await seedPerson();
    await setPhotoFromUpload(person.id, { type: "image/png", size: 100, bytes: await pngBytes() }, 4);

    const resolved = await resolvePhoto(person.id);

    expect(resolved).not.toBeNull();
    expect(vi.mocked(fetchYaliesPhoto)).not.toHaveBeenCalled();
  });

  it("returns null for an unknown person", async () => {
    expect(await resolvePhoto("does-not-exist")).toBeNull();
  });

  it("records no miss when no API key is configured", async () => {
    vi.mocked(isYaliesEnabled).mockReturnValue(false);
    const person = await seedPerson();

    expect(await resolvePhoto(person.id)).toBeNull();

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoSyncMisses).toBe(0);
    expect(after.photoSyncedAt).toBeNull();
    expect(vi.mocked(fetchYaliesPhoto)).not.toHaveBeenCalled();
  });
});

describe("setPhotoFromUpload", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("stores the photo and marks it upload-sourced", async () => {
    const person = await seedPerson();

    await setPhotoFromUpload(person.id, { type: "image/png", size: 100, bytes: await pngBytes() }, 4);

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoSource).toBe("upload");
    expect(after.photoKey).toBe(`people/${person.id}`);
    expect(after.photoVersion).toBe(1);
  });

  it("clears suppression", async () => {
    const person = await seedPerson({ photoSuppressed: true });

    await setPhotoFromUpload(person.id, { type: "image/png", size: 100, bytes: await pngBytes() }, 4);

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoSuppressed).toBe(false);
  });

  it("rejects an unsupported type", async () => {
    const person = await seedPerson();

    await expect(
      setPhotoFromUpload(person.id, { type: "application/pdf", size: 100, bytes: Buffer.from("x") }, 4)
    ).rejects.toBeInstanceOf(PhotoError);
  });

  it("rejects a file over the size limit", async () => {
    const person = await seedPerson();

    await expect(
      setPhotoFromUpload(
        person.id,
        { type: "image/png", size: 9 * 1024 * 1024, bytes: await pngBytes() },
        4
      )
    ).rejects.toBeInstanceOf(PhotoError);
  });

  it("keeps the version monotonic across replacement", async () => {
    const person = await seedPerson();
    const file = { type: "image/png", size: 100, bytes: await pngBytes() };

    await setPhotoFromUpload(person.id, file, 4);
    await removePhoto(person.id);
    await setPhotoFromUpload(person.id, file, 4);

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoVersion).toBe(3);
  });
});

describe("removePhoto", () => {
  beforeEach(async () => {
    await resetDb();
    vi.mocked(isYaliesEnabled).mockReturnValue(true);
    vi.mocked(fetchYaliesPhoto).mockResolvedValue(await pngBytes());
  });

  it("suppresses future pulls when removing a Yalies photo", async () => {
    const person = await seedPerson();
    await resolvePhoto(person.id);

    await removePhoto(person.id);

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoKey).toBeNull();
    expect(after.photoSuppressed).toBe(true);
    expect(await getObject(`people/${person.id}`)).toBeNull();
  });

  it("does not suppress when removing an uploaded photo", async () => {
    const person = await seedPerson();
    await setPhotoFromUpload(person.id, { type: "image/png", size: 100, bytes: await pngBytes() }, 4);

    await removePhoto(person.id);

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.photoKey).toBeNull();
    expect(after.photoSuppressed).toBe(false);
  });

  it("leaves a suppressed person alone on a later resolve", async () => {
    const person = await seedPerson();
    await resolvePhoto(person.id);
    await removePhoto(person.id);
    vi.mocked(fetchYaliesPhoto).mockClear();

    expect(await resolvePhoto(person.id)).toBeNull();
    expect(vi.mocked(fetchYaliesPhoto)).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:prepare && npx vitest run src/platform/photos/service.test.ts`
Expected: FAIL, cannot resolve `./service`.

- [ ] **Step 3: Write the implementation**

Create `src/platform/photos/service.ts`:

```ts
/**
 * Member profile photo state, and the only writer of Person's photo columns.
 *
 * Photos come from two places. Yale College students are auto-sourced from the
 * Yalies API on first view; everyone else uploads their own. Removing an
 * auto-sourced photo suppresses further pulls, which is what makes opt-out real,
 * given that Yalies photos are applied without asking first.
 */
import { prisma } from "@/platform/db";
import { deleteObject, getObject, putObject } from "@/platform/storage";
import { normalizePhoto } from "./normalize";
import { PHOTO_CONTENT_TYPE, PhotoError } from "./shared";
import { shouldAttemptYaliesPull } from "./policy";
import { fetchYaliesPhoto, isYaliesEnabled } from "./yalies";

/** Upload types we accept. Everything is re-encoded to WebP regardless. */
export const ACCEPTED_UPLOAD_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export type ResolvedPhoto = { bytes: Buffer; contentType: string } | null;

/** Object storage key for a person's photo. Fixed, so a new photo overwrites. */
function photoKeyFor(personId: string): string {
  return `people/${personId}`;
}

/**
 * Write bytes, then the row. If the row write fails, drop the bytes.
 *
 * Order matters and is the same one platform/branding/assets.ts uses. Writing
 * the row first would point photoKey at an object that may never arrive, and
 * the route would then serve a 404 for a person the database says has a photo.
 */
async function storePhoto(
  personId: string,
  bytes: Buffer,
  source: "yalies" | "upload"
): Promise<void> {
  const key = photoKeyFor(personId);
  await putObject(key, bytes, PHOTO_CONTENT_TYPE);
  try {
    await prisma.person.update({
      where: { id: personId },
      data: {
        photoKey: key,
        photoSource: source,
        photoVersion: { increment: 1 },
        photoUpdatedAt: new Date(),
        photoSyncMisses: 0,
        // An upload is an affirmative choice to have a photo, so it clears a
        // prior "do not use my Yale photo". A Yalies pull cannot reach here
        // while suppressed, so writing false is a no-op on that path.
        photoSuppressed: false,
      },
    });
  } catch (err) {
    await deleteObject(key).catch(() => undefined);
    throw err;
  }
}

/**
 * The person's photo bytes, fetching from Yalies on a miss when policy allows.
 *
 * Returns null when there is no photo, which callers render as initials. Never
 * throws on a Yalies failure: every one of those is recorded as a miss.
 */
export async function resolvePhoto(personId: string, now: Date = new Date()): Promise<ResolvedPhoto> {
  const person = await prisma.person.findUnique({
    where: { id: personId },
    select: {
      id: true,
      netId: true,
      yaleAffiliation: true,
      photoKey: true,
      photoSuppressed: true,
      photoSyncedAt: true,
      photoSyncMisses: true,
    },
  });
  if (!person) return null;

  if (person.photoKey) {
    const bytes = await getObject(person.photoKey);
    if (bytes) return { bytes, contentType: PHOTO_CONTENT_TYPE };
    // The row points at bytes that are gone. Fall through and treat it as a
    // miss rather than serving a broken image.
  }

  if (!shouldAttemptYaliesPull(person, now)) return null;

  // Without an API key the feature is inert. Check before attempting rather than
  // letting fetchYaliesPhoto return null, which would be recorded as a miss:
  // that would churn photoSyncedAt and photoSyncMisses on every view in local
  // dev and CI, where no key is configured. policy.ts stays free of config
  // dependencies, so the check lives here rather than in the predicate.
  if (!isYaliesEnabled()) return null;

  const fetched = await fetchYaliesPhoto(person.netId as string);
  if (!fetched) {
    await prisma.person.update({
      where: { id: personId },
      data: { photoSyncedAt: now, photoSyncMisses: { increment: 1 } },
    });
    return null;
  }

  let normalized: Buffer;
  try {
    normalized = await normalizePhoto(fetched);
  } catch {
    // Yalies handed us bytes sharp cannot read. Their problem, our miss.
    await prisma.person.update({
      where: { id: personId },
      data: { photoSyncedAt: now, photoSyncMisses: { increment: 1 } },
    });
    return null;
  }

  await storePhoto(personId, normalized, "yalies");
  await prisma.person.update({ where: { id: personId }, data: { photoSyncedAt: now } });
  return { bytes: normalized, contentType: PHOTO_CONTENT_TYPE };
}

/** Validate, normalize, and store a member- or admin-supplied photo. */
export async function setPhotoFromUpload(
  personId: string,
  file: { type: string; size: number; bytes: Buffer },
  maxMb: number
): Promise<void> {
  if (!ACCEPTED_UPLOAD_TYPES.has(file.type)) {
    throw new PhotoError(`Unsupported image type "${file.type}". Use PNG, JPEG, or WebP.`);
  }
  if (file.size > maxMb * 1024 * 1024) {
    throw new PhotoError(`Image too large; the limit is ${maxMb} MB.`);
  }
  await storePhoto(personId, await normalizePhoto(file.bytes), "upload");
}

/**
 * Clear the person's photo.
 *
 * Removing a Yalies-sourced photo sets photoSuppressed, meaning "do not use my
 * Yale photo". Removing a self-uploaded one does not: deleting your own upload
 * says nothing about the Yale photo, so backfill may refill it.
 */
export async function removePhoto(personId: string): Promise<void> {
  const person = await prisma.person.findUnique({
    where: { id: personId },
    select: { photoKey: true, photoSource: true },
  });
  if (!person) return;

  if (person.photoKey) await deleteObject(person.photoKey).catch(() => undefined);

  await prisma.person.update({
    where: { id: personId },
    data: {
      photoKey: null,
      photoSource: null,
      photoVersion: { increment: 1 },
      photoUpdatedAt: new Date(),
      photoSuppressed: person.photoSource === "yalies",
    },
  });
}
```

- [ ] **Step 4: Write the module barrel**

Create `src/platform/photos/index.ts`:

```ts
/**
 * Server-side barrel for the photos module.
 *
 * This re-exports service.ts (Prisma) and normalize.ts (sharp), so importing it
 * from a "use client" component would bundle both for the browser. Client
 * components import "@/platform/photos/shared" instead.
 */
export { PHOTO_CONTENT_TYPE, PHOTO_SIZE, PhotoError, photoUrl } from "./shared";
export { normalizePhoto } from "./normalize";
export { initialsSvg, toInitials } from "./initials";
export {
  ACCEPTED_UPLOAD_TYPES,
  removePhoto,
  resolvePhoto,
  setPhotoFromUpload,
  type ResolvedPhoto,
} from "./service";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/platform/photos/service.test.ts`
Expected: 14 passed.

- [ ] **Step 6: Commit**

```bash
git add src/platform/photos/service.ts src/platform/photos/service.test.ts src/platform/photos/index.ts
git commit -m "feat(photos): add photo service with lazy Yalies sourcing and upload override"
```

---

### Task 7: Authenticated photo route

**Files:**
- Create: `src/app/api/people/[personId]/photo/route.ts`
- Create: `src/app/api/people/[personId]/photo/route.test.ts`

**Interfaces:**
- Consumes: `resolvePhoto`, `initialsSvg` (Task 6); `auth` from `@/platform/auth/auth`; `can` from `@/platform/rbac/engine`
- Produces: `GET /api/people/[personId]/photo?v=<n>`

This route uses `auth()` and `can()` directly rather than `requirePermission`, because the session helpers redirect on denial and an `<img>` request needs a status code.

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/people/[personId]/photo/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/rbac/engine", () => ({ can: vi.fn() }));
vi.mock("@/platform/photos", () => ({
  resolvePhoto: vi.fn(),
  initialsSvg: vi.fn(() => "<svg></svg>"),
}));
vi.mock("@/platform/db", () => ({
  prisma: { person: { findUnique: vi.fn(async () => ({ name: "Ada Lovelace" })) } },
}));

import { auth } from "@/platform/auth/auth";
import { can } from "@/platform/rbac/engine";
import { resolvePhoto } from "@/platform/photos";
import { GET } from "./route";

function request(): Request {
  return new Request("https://hub.test/api/people/p1/photo?v=3");
}

function context(personId = "p1") {
  return { params: Promise.resolve({ personId }) };
}

describe("GET /api/people/[personId]/photo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({ personId: "p1" } as never);
    vi.mocked(can).mockResolvedValue(false);
    vi.mocked(resolvePhoto).mockResolvedValue({
      bytes: Buffer.from([1, 2, 3]),
      contentType: "image/webp",
    });
  });

  it("serves a member their own photo", async () => {
    const res = await GET(request(), context("p1"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
  });

  it("marks a real photo immutable, since the URL is versioned", async () => {
    const res = await GET(request(), context("p1"));

    expect(res.headers.get("Cache-Control")).toContain("immutable");
  });

  it("sets nosniff and a restrictive CSP on user-supplied bytes", async () => {
    const res = await GET(request(), context("p1"));

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  it("refuses an unauthenticated request", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    expect((await GET(request(), context("p1"))).status).toBe(401);
  });

  it("refuses one member reading another's photo", async () => {
    const res = await GET(request(), context("p2"));

    expect(res.status).toBe(403);
    expect(vi.mocked(resolvePhoto)).not.toHaveBeenCalled();
  });

  it("allows a people admin to read another's photo", async () => {
    vi.mocked(can).mockResolvedValue(true);

    expect((await GET(request(), context("p2"))).status).toBe(200);
    expect(vi.mocked(can)).toHaveBeenCalledWith("p1", "admin.manage_people");
  });

  it("falls back to an initials SVG when there is no photo", async () => {
    vi.mocked(resolvePhoto).mockResolvedValue(null);

    const res = await GET(request(), context("p1"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
  });

  it("never caches the initials fallback", async () => {
    vi.mocked(resolvePhoto).mockResolvedValue(null);

    const res = await GET(request(), context("p1"));

    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("falls back to initials when the photo lookup throws", async () => {
    vi.mocked(resolvePhoto).mockRejectedValue(new Error("database unreachable"));

    const res = await GET(request(), context("p1"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run "src/app/api/people/[personId]/photo/route.test.ts"`
Expected: FAIL, cannot resolve `./route`.

- [ ] **Step 3: Write the implementation**

Create `src/app/api/people/[personId]/photo/route.ts`:

```ts
/**
 * GET /api/people/[personId]/photo -- in-app member photo serving.
 *
 * The seam that keeps the Yalies API off every render path. Pages emit an <img>
 * pointing here and never await a third party themselves; a slow Yalies degrades
 * to one slow-loading avatar instead of a slow page. This is also the only route
 * that triggers a lazy Yalies pull. The public credential photo route
 * deliberately does not.
 *
 * Uses auth()/can() rather than requirePermission because the session helpers
 * redirect on denial, and an <img> request needs a status code.
 */
import { auth } from "@/platform/auth/auth";
import { prisma } from "@/platform/db";
import { initialsSvg, resolvePhoto } from "@/platform/photos";
import { can } from "@/platform/rbac/engine";

type RouteContext = { params: Promise<{ personId: string }> };

/** Raster/SVG only, so nosniff plus a null CSP neutralizes any active content. */
const IMAGE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
};

/** The initials placeholder, never cached so a real photo can replace it. */
async function initialsResponse(personId: string): Promise<Response> {
  const person = await prisma.person
    .findUnique({ where: { id: personId }, select: { name: true } })
    .catch(() => null);

  return new Response(initialsSvg(person?.name ?? null), {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "no-store",
      ...IMAGE_SECURITY_HEADERS,
    },
  });
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { personId } = await context.params;

  const session = await auth();
  if (!session?.personId) return new Response("Unauthorized", { status: 401 });

  if (session.personId !== personId && !(await can(session.personId, "admin.manage_people"))) {
    return new Response("Forbidden", { status: 403 });
  }

  // A photo failure must never break the surface asking for it. Reads degrade to
  // initials, consistent with the app's posture when the database is unreachable.
  const photo = await resolvePhoto(personId).catch(() => null);
  if (!photo) return initialsResponse(personId);

  return new Response(new Uint8Array(photo.bytes), {
    status: 200,
    headers: {
      "Content-Type": photo.contentType,
      // Safe despite the long max-age: the URL carries ?v=<photoVersion>, which
      // increments on every set and every removal.
      "Cache-Control": "private, max-age=31536000, immutable",
      ...IMAGE_SECURITY_HEADERS,
    },
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run "src/app/api/people/[personId]/photo/route.test.ts"`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/people/[personId]/photo"
git commit -m "feat(photos): add authenticated photo route with lazy Yalies self-heal"
```

---

### Task 8: Public credential photo route

**Files:**
- Create: `src/app/credential/[token]/photo/route.ts`
- Create: `src/app/credential/[token]/photo/route.test.ts`

**Interfaces:**
- Consumes: `getObject` from `@/platform/storage`; `PHOTO_CONTENT_TYPE` (Task 2)
- Produces: `GET /credential/[token]/photo?v=<n>`

Unauthenticated, so it reads stored bytes only and never triggers a Yalies pull. An anonymous route that can cause outbound third-party fetches is an abuse vector.

- [ ] **Step 1: Write the failing tests**

Create `src/app/credential/[token]/photo/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/db", () => ({
  prisma: { serviceCredential: { findUnique: vi.fn() } },
}));
vi.mock("@/platform/storage", () => ({ getObject: vi.fn() }));
vi.mock("@/platform/photos", () => ({ resolvePhoto: vi.fn() }));

import { prisma } from "@/platform/db";
import { getObject } from "@/platform/storage";
import { resolvePhoto } from "@/platform/photos";
import { GET } from "./route";

function request(): Request {
  return new Request("https://hub.test/credential/tok123/photo?v=2");
}

const context = { params: Promise.resolve({ token: "tok123" }) };

/** A published, non-revoked credential whose person has a photo. */
function published(overrides: Record<string, unknown> = {}) {
  return {
    revokedAt: null,
    person: { id: "p1", photoKey: "people/p1" },
    ...overrides,
  };
}

describe("GET /credential/[token]/photo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.serviceCredential.findUnique).mockResolvedValue(published() as never);
    vi.mocked(getObject).mockResolvedValue(Buffer.from([1, 2, 3]));
  });

  it("serves the stored photo for a published credential", async () => {
    const res = await GET(request(), context);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
  });

  it("caches publicly, since the URL is versioned", async () => {
    const res = await GET(request(), context);

    expect(res.headers.get("Cache-Control")).toContain("public");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
  });

  it("sets nosniff and a restrictive CSP", async () => {
    const res = await GET(request(), context);

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  it("404s for an unknown or unpublished token", async () => {
    vi.mocked(prisma.serviceCredential.findUnique).mockResolvedValue(null as never);

    expect((await GET(request(), context)).status).toBe(404);
  });

  it("404s for a revoked credential", async () => {
    vi.mocked(prisma.serviceCredential.findUnique).mockResolvedValue(
      published({ revokedAt: new Date() }) as never
    );

    expect((await GET(request(), context)).status).toBe(404);
  });

  it("404s when the person has no photo", async () => {
    vi.mocked(prisma.serviceCredential.findUnique).mockResolvedValue(
      published({ person: { id: "p1", photoKey: null } }) as never
    );

    expect((await GET(request(), context)).status).toBe(404);
  });

  it("404s when the stored object is missing", async () => {
    vi.mocked(getObject).mockResolvedValue(null);

    expect((await GET(request(), context)).status).toBe(404);
  });

  it("never triggers a Yalies pull", async () => {
    await GET(request(), context);

    expect(vi.mocked(resolvePhoto)).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run "src/app/credential/[token]/photo/route.test.ts"`
Expected: FAIL, cannot resolve `./route`.

- [ ] **Step 3: Write the implementation**

Create `src/app/credential/[token]/photo/route.ts`:

```ts
/**
 * GET /credential/[token]/photo -- the photo on a public credential page.
 *
 * Keyed on the credential's unguessable publicToken rather than a personId, so
 * the public surface never exposes an internal id and cannot be enumerated. It
 * inherits publish, unpublish, and revoke gating for free: unpublishing nulls
 * the token, which makes this 404 alongside the page itself.
 *
 * Unlike the in-app route, this one reads stored bytes only and NEVER triggers a
 * Yalies pull. An anonymous endpoint that can cause outbound third-party fetches
 * is an abuse vector.
 *
 * The photo is resolved live rather than frozen into ServiceCredential.record,
 * so a member removing their photo clears it here immediately.
 */
import { prisma } from "@/platform/db";
import { PHOTO_CONTENT_TYPE } from "@/platform/photos";
import { getObject } from "@/platform/storage";

type RouteContext = { params: Promise<{ token: string }> };

const NOT_FOUND = new Response("Not found", { status: 404 });

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { token } = await context.params;

  const credential = await prisma.serviceCredential
    .findUnique({
      where: { publicToken: token },
      select: { revokedAt: true, person: { select: { id: true, photoKey: true } } },
    })
    .catch(() => null);

  if (!credential || credential.revokedAt || !credential.person.photoKey) {
    return NOT_FOUND.clone();
  }

  const bytes = await getObject(credential.person.photoKey).catch(() => null);
  if (!bytes) return NOT_FOUND.clone();

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": PHOTO_CONTENT_TYPE,
      // The page renders ?v=<photoVersion>, so a changed photo is a changed URL.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run "src/app/credential/[token]/photo/route.test.ts"`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add "src/app/credential/[token]/photo"
git commit -m "feat(photos): add public credential photo route"
```

---

### Task 9: PersonPhoto component and account menu

**Files:**
- Create: `src/platform/ui/person-photo.tsx`
- Modify: `src/platform/ui/account-menu.tsx` (remove the local `toInitials` at line 8, replace the initials div at line 81)

**Interfaces:**
- Consumes: `photoUrl` (Task 2, from `@/platform/photos/shared`)
- Produces: `<PersonPhoto person={{ id, name, photoVersion }} size={number} />`

The component has no fallback branch. The route already returns initials when there is no photo, so `<img>` always resolves to something with the right dimensions.

**Import discipline, and why it matters here.** `account-menu.tsx` carries `"use client"` at line 1, so everything it imports is bundled for the browser. `PersonPhoto` is rendered inside it, which makes `PersonPhoto`'s imports client imports too. Import `photoUrl` from `@/platform/photos/shared`, **never** from `@/platform/photos`: the barrel re-exports sharp and Prisma. Verify after wiring with:

```bash
grep -rn "@/platform/photos\"" src/platform/ui src/modules
```

Any hit in a file that carries `"use client"`, or in a file imported by one, is the bug this note exists to prevent.

- [ ] **Step 1: Write the component**

Create `src/platform/ui/person-photo.tsx`:

```tsx
/**
 * A person's photo, or their initials when they have none.
 *
 * There is deliberately no fallback branch here. The photo route serves an
 * initials SVG when a person has no photo, so this <img> always resolves to
 * something with the right dimensions and the component stays a one-liner.
 */
import { photoUrl } from "@/platform/photos/shared";

type PersonPhotoProps = {
  person: { id: string; name: string | null; photoVersion: number };
  /** Rendered edge length in pixels. */
  size: number;
  className?: string;
};

export function PersonPhoto({ person, size, className }: PersonPhotoProps) {
  return (
    <img
      src={photoUrl(person)}
      alt={person.name ?? "Member"}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={className ?? "rounded-full object-cover"}
      style={{ width: size, height: size }}
    />
  );
}
```

- [ ] **Step 2: Render the photo in the account menu**

In `src/platform/ui/account-menu.tsx`, replace the initials element at line 81 with the photo component. Read the surrounding markup first with `sed -n '70,95p' src/platform/ui/account-menu.tsx` and keep the existing wrapper classes, substituting only the inner content:

```tsx
<PersonPhoto person={person} size={32} />
```

Then delete the now-unused local `toInitials` function (around line 8). Do **not** replace it with an import: the route renders initials server-side, so the client no longer needs the helper at all. Task 4 already has its own copy for the route.

The menu's data loader must now supply `id`, `name`, and `photoVersion` for the signed-in person. If it currently supplies only a name, widen the query.

- [ ] **Step 3: Verify types, lint, and the client-bundle boundary**

Run: `npx tsc --noEmit && npx eslint src e2e`
Expected: both clean.

Then confirm no client component reaches the server barrel:

```bash
grep -rn "@/platform/photos\"" src/platform/ui src/modules
```

Expected: no hits in any file carrying `"use client"`. If `toInitials` was exported from `account-menu.tsx` and imported elsewhere, point those importers at `@/platform/photos/initials`.

- [ ] **Step 4: Run the full unit suite**

Run: `npx vitest run`
Expected: all pass. Read the counts, not the exit code.

- [ ] **Step 5: Commit**

```bash
git add src/platform/ui/person-photo.tsx src/platform/ui/account-menu.tsx
git commit -m "feat(photos): add PersonPhoto component and show it in the account menu"
```

---

### Task 10: My-info photo card

**Files:**
- Create: `src/modules/my-info/components/photo-card.tsx`
- Modify: `src/app/(app)/my-info/page.tsx` (add two server actions and render the card)

**Interfaces:**
- Consumes: `setPhotoFromUpload`, `removePhoto`, `PhotoError` (Task 6); `PersonPhoto` (Task 9); `getSetting` from `@/platform/settings/service`
- Produces: `<PhotoCard person={...} maxMb={number} />`

Removal must be genuinely discoverable here. Yalies photos are applied without asking first, so this control is what makes opt-out real rather than nominal.

- [ ] **Step 1: Write the card**

Create `src/modules/my-info/components/photo-card.tsx`. Match the surrounding cards' markup by reading `src/modules/my-info/components/hipaa-panel.tsx` first, then:

```tsx
/**
 * The member's own photo, with upload and remove.
 *
 * Yale College photos are auto-sourced from Yalies without asking first, so the
 * remove control here is the opt-out. Keep it visible rather than tucked behind
 * a menu: it is the only place a member can decline a photo they never chose.
 */
import { PersonPhoto } from "@/platform/ui/person-photo";

type PhotoCardProps = {
  person: { id: string; name: string | null; photoVersion: number; photoKey: string | null };
  maxMb: number;
  uploadAction: (formData: FormData) => Promise<void>;
  removeAction: () => Promise<void>;
};

export function PhotoCard({ person, maxMb, uploadAction, removeAction }: PhotoCardProps) {
  return (
    <div className="flex items-center gap-6">
      <PersonPhoto person={person} size={96} />
      <div className="space-y-3">
        <form action={uploadAction} className="space-y-2">
          <input
            type="file"
            name="photo"
            accept="image/png,image/jpeg,image/webp"
            required
            className="block text-sm"
          />
          <button type="submit" className="btn-primary">
            Save photo
          </button>
        </form>
        <p className="text-sm text-fg-muted">
          PNG, JPEG, or WebP, up to {maxMb} MB. Square images work best.
        </p>
        {person.photoKey ? (
          <form action={removeAction}>
            <button type="submit" className="btn-secondary">
              Remove photo
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
```

The class names above are placeholders and will not exist in this codebase. Before writing the file, run:

```bash
grep -rhoE 'className="[^"]*"' src/modules/my-info/components/hipaa-panel.tsx | sort -u
```

Use the button, muted-text, and spacing classes that come back. Do not invent class names, and do not introduce `tailwind-merge`: the project's UI cohesion work deliberately removed it.

- [ ] **Step 2: Add the server actions to the page**

In `src/app/(app)/my-info/page.tsx`, alongside the existing `uploadAction`, add:

```tsx
  async function photoUploadAction(formData: FormData) {
    "use server";
    const session = await requireModuleAccess("my-info");
    const file = formData.get("photo");
    if (!(file instanceof File) || file.size === 0) {
      redirect("/my-info?photoError=Choose+an+image+file.");
    }
    try {
      await setPhotoFromUpload(
        session.personId,
        { type: file.type, size: file.size, bytes: Buffer.from(await file.arrayBuffer()) },
        await getSetting<number>("uploads.maxMb")
      );
    } catch (err) {
      if (err instanceof PhotoError) {
        redirect(`/my-info?photoError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect("/my-info?photoSaved=1");
  }

  async function photoRemoveAction() {
    "use server";
    const session = await requireModuleAccess("my-info");
    await removePhoto(session.personId);
    redirect("/my-info?photoRemoved=1");
  }
```

Add the imports at the top of the file:

```tsx
import { PhotoError, removePhoto, setPhotoFromUpload } from "@/platform/photos";
import { PhotoCard } from "@/modules/my-info/components/photo-card";
```

- [ ] **Step 3: Render the card**

The page's `getMyInfo` result must carry `photoVersion` and `photoKey`. Widen that select in `src/modules/my-info/services/my-info.ts`, then render the card inside a `SectionHeader` block matching its neighbours:

```tsx
<PhotoCard
  person={{
    id: person.personId,
    name: person.name,
    photoVersion: myInfo.person.photoVersion,
    photoKey: myInfo.person.photoKey,
  }}
  maxMb={maxMb}
  uploadAction={photoUploadAction}
  removeAction={photoRemoveAction}
/>
```

Resolve `maxMb` in the existing `Promise.all` block with `getSetting<number>("uploads.maxMb")`.

Surface `photoError`, `photoSaved`, and `photoRemoved` from `searchParams` using the same toast or alert mechanism the page already uses for `certError` and `saved`. Add them to the `PageProps` `searchParams` type.

- [ ] **Step 4: Verify types, lint, and tests**

Run: `npx tsc --noEmit && npx eslint src e2e && npx vitest run`
Expected: all clean.

- [ ] **Step 5: Check the my-info e2e spec still passes**

Run: `npx playwright test e2e --grep my-info`
Expected: pass. A new card can disturb existing selectors. If a test breaks on an ambiguous locator, tighten that locator rather than removing the card.

- [ ] **Step 6: Commit**

```bash
git add src/modules/my-info "src/app/(app)/my-info/page.tsx"
git commit -m "feat(photos): let members upload and remove their own photo"
```

---

### Task 11: Admin photo controls

**Files:**
- Modify: `src/app/(app)/admin/people/[id]/page.tsx` (add two server actions, render controls)
- Modify: `src/app/(app)/admin/people/page.tsx` (show the photo in the list)

**Interfaces:**
- Consumes: `setPhotoFromUpload`, `removePhoto`, `PhotoError` (Task 6); `PersonPhoto` (Task 9); `PhotoCard` (Task 10)
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Add the server actions**

In `src/app/(app)/admin/people/[id]/page.tsx`, alongside the existing actions:

```tsx
  async function photoUploadAction(formData: FormData) {
    "use server";
    await requirePermission("admin.manage_people");
    const file = formData.get("photo");
    if (!(file instanceof File) || file.size === 0) {
      redirect(`/admin/people/${id}?photoError=Choose+an+image+file.`);
    }
    try {
      await setPhotoFromUpload(
        id,
        { type: file.type, size: file.size, bytes: Buffer.from(await file.arrayBuffer()) },
        await getSetting<number>("uploads.maxMb")
      );
    } catch (err) {
      if (err instanceof PhotoError) {
        redirect(`/admin/people/${id}?photoError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/admin/people/${id}?photoSaved=1`);
  }

  async function photoRemoveAction() {
    "use server";
    await requirePermission("admin.manage_people");
    await removePhoto(id);
    redirect(`/admin/people/${id}?photoRemoved=1`);
  }
```

Confirm the page's route param is named `id` by reading its `PageProps`, and match whatever it actually uses.

- [ ] **Step 2: Render the controls**

Reuse the `PhotoCard` from Task 10, passing the admin actions. Widen the page's person query to select `photoVersion` and `photoKey`.

- [ ] **Step 3: Show the photo in the people list**

In `src/app/(app)/admin/people/page.tsx`, add a leading cell to each row:

```tsx
<PersonPhoto person={p} size={32} />
```

Widen the list query to select `photoVersion` alongside `id` and `name`.

- [ ] **Step 4: Verify types, lint, and tests**

Run: `npx tsc --noEmit && npx eslint src e2e && npx vitest run`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/admin/people"
git commit -m "feat(photos): show and manage member photos in admin people views"
```

---

### Task 12: Public credential page photo

**Files:**
- Modify: `src/app/credential/[token]/page.tsx`

**Interfaces:**
- Consumes: `GET /credential/[token]/photo` (Task 8)
- Produces: nothing

The page renders a plain `<img>` at the public route rather than `<PersonPhoto>`, because `PersonPhoto` points at the authenticated per-person route and this page has no session.

- [ ] **Step 1: Widen the page query**

The page currently resolves the credential by token. Add `photoVersion` and `photoKey` to the selected person fields so the page can both decide whether to render an image and build a versioned URL.

- [ ] **Step 2: Render the photo**

Where the page shows the member's name, add above it:

```tsx
{credential.person.photoKey ? (
  <img
    src={`/credential/${token}/photo?v=${credential.person.photoVersion}`}
    alt={credential.record.name}
    width={128}
    height={128}
    className="rounded-full object-cover"
  />
) : null}
```

Match the surrounding layout classes. The `photoKey` guard avoids a broken image for members without a photo, since the route 404s in that case.

- [ ] **Step 3: Verify types, lint, and tests**

Run: `npx tsc --noEmit && npx eslint src e2e && npx vitest run`
Expected: all clean.

- [ ] **Step 4: Manual verification**

Run `npm run dev`, sign in, publish your credential from `/my-info`, then open the public credential URL in a private window. Confirm the photo appears. Remove the photo from `/my-info` and reload the public page. Confirm the photo is gone immediately, which is the behaviour that makes opt-out real.

- [ ] **Step 5: Full verification before push**

Run: `npx eslint src e2e && npx tsc --noEmit && npx vitest run && npx playwright test`
Expected: all clean. Read the vitest and playwright pass/fail counts directly.

- [ ] **Step 6: Commit**

```bash
git add "src/app/credential/[token]/page.tsx"
git commit -m "feat(photos): show member photo on the public credential page"
```

---

## Deferred, not forgotten

Recorded in the spec's Scope section and deliberately absent from this plan:

- **Wallet badge thumbnail.** `wallet-pass.ts` wires logo, icon, and strip only. Whether the pass vendor accepts a per-member thumbnail on our pass style is unverified, so it is not specified here on an assumption.
- **Certificate PDF photo.** Never discussed during brainstorming.
- **Batch sync**, a consequence of choosing lazy fetching over a scheduled sweep.
- **Admin force-refresh** and a **block-photos flag**, both declined.
