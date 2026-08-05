# Vercel Blob to Cloudflare R2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all uploaded-file storage from Vercel Blob to Cloudflare R2, keeping every storage key byte-identical so no database row has to change.

**Architecture:** `src/platform/storage.ts` becomes a `src/platform/storage/` directory with a stable public API (`putObject`, `getObject`, `deleteObject`, `deletePrefix`) and two interchangeable drivers behind it: R2 over the S3-compatible API for deployed environments, and the existing local filesystem for dev, CI, and tests. The one path that cannot use that API (SCORM `.zip` uploads, which exceed Vercel's 4.5 MB function body limit) moves from Vercel Blob client tokens to an S3 presigned PUT URL.

**Tech Stack:** Next.js App Router, TypeScript, zod (env validation), vitest, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, tsx (scripts).

**Spec:** `docs/superpowers/specs/2026-08-05-vercel-blob-to-r2-design.md`

## Global Constraints

- **No em-dashes anywhere.** CI enforces this via the `local/no-em-dash` eslint rule and lint failure blocks merge. Use `--` in prose comments, matching existing code.
- **Storage keys must not change.** A Vercel Blob `pathname` is already the storage key (`putObject` has always set `addRandomSuffix: false`). Every `storedName` in the database keeps working untouched.
- **The public API of `@/platform/storage` must not change.** 24 files import it. None of them may be edited in this work except for the `usingBlobStorage` rename.
- **Local dev, CI, and the test suite must require zero configuration.** No R2 credentials anywhere in the test path.
- **Run `npm run lint` (whole repo) before any push.** `typecheck` and `test` do not catch eslint boundary violations. Use `npx eslint src e2e scripts` locally to avoid noise from the gitignored design-system directory.
- **Presigned upload content type must match exactly.** The client declares `application/zip` when requesting the URL and sends the identical `Content-Type` header on the PUT. Any mismatch fails with `SignatureDoesNotMatch`.

---

### Task 1: R2 environment variables with an all-or-nothing guard

**Files:**
- Modify: `src/platform/config.ts` (add fields to the schema object; add one `superRefine` after the existing two)
- Modify: `src/platform/config.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing.
- Produces: `config.R2_ACCOUNT_ID`, `config.R2_ACCESS_KEY_ID`, `config.R2_SECRET_ACCESS_KEY`, `config.R2_BUCKET`, all `string | undefined`. Task 2 and Task 3 read these.

**Why the guard matters:** today a missing `BLOB_READ_WRITE_TOKEN` silently degrades to the disk driver. On Vercel the function filesystem is ephemeral, so uploads appear to succeed and then vanish on the next deploy, with no error anywhere. Three-of-four R2 variables in production would reproduce exactly that failure mode. This must fail at boot.

- [ ] **Step 1: Write the failing tests**

Add to `src/platform/config.test.ts`, inside the existing `describe("loadConfig", ...)` block:

```ts
const r2 = {
  R2_ACCOUNT_ID: "acct123",
  R2_ACCESS_KEY_ID: "akid",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "havenhub-uploads",
};

it("accepts an env with no R2 variables at all (local disk storage)", () => {
  const config = loadConfig(base);
  expect(config.R2_BUCKET).toBeUndefined();
});

it("accepts a complete R2 configuration", () => {
  const config = loadConfig({ ...base, ...r2 });
  expect(config.R2_BUCKET).toBe("havenhub-uploads");
  expect(config.R2_ACCOUNT_ID).toBe("acct123");
});

it("rejects a partial R2 configuration, naming the missing variable", () => {
  // A partial config silently falls back to local disk. On Vercel the function
  // filesystem is ephemeral, so every upload would vanish on the next deploy
  // with no error. It has to fail at boot instead.
  const { R2_SECRET_ACCESS_KEY: _omitted, ...partial } = r2;
  expect(() => loadConfig({ ...base, ...partial })).toThrowError(
    /R2_SECRET_ACCESS_KEY/
  );
});

it("rejects a lone R2_ACCOUNT_ID rather than silently using local disk", () => {
  expect(() => loadConfig({ ...base, R2_ACCOUNT_ID: "acct123" })).toThrowError(
    /R2_BUCKET/
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/platform/config.test.ts`
Expected: the two rejection tests FAIL (no error thrown, because the fields do not exist yet). The two acceptance tests may pass trivially.

- [ ] **Step 3: Add the schema fields**

In `src/platform/config.ts`, add inside the `z.object({ ... })`, directly after the `UPLOAD_DIR` field:

```ts
    // Cloudflare R2 object storage, used in every deployed environment. All four
    // are required together: see the all-or-nothing superRefine below.
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET: z.string().optional(),
```

- [ ] **Step 4: Add the all-or-nothing guard**

In `src/platform/config.ts`, append a third `.superRefine(...)` after the existing `EMAIL_TRANSPORT` one, before `export type AppConfig`:

```ts
  .superRefine((env, ctx) => {
    // R2 configuration is all-or-nothing. With a partial config, storage falls
    // back to local disk -- and on Vercel the function filesystem is ephemeral,
    // so uploads appear to succeed and then vanish on the next deploy, with no
    // error anywhere. Refuse to boot instead of losing files quietly.
    const keys = [
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET",
    ] as const;
    const present = keys.filter((key) => env[key]);
    if (present.length === 0 || present.length === keys.length) return;
    for (const key of keys) {
      if (!env[key]) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message:
            "required when any other R2_* variable is set (R2 config is all-or-nothing)",
        });
      }
    }
  })
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/platform/config.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Document the variables**

Add to `.env.example`, below the existing upload settings:

```bash
# Cloudflare R2 object storage. Set all four together or none at all; a partial
# configuration is rejected at boot. Leave unset for local development, where
# uploads go to UPLOAD_DIR on disk.
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
```

- [ ] **Step 7: Commit**

```bash
git add src/platform/config.ts src/platform/config.test.ts .env.example
git commit -m "feat(config): add R2 storage variables with an all-or-nothing guard"
```

---

### Task 2: The R2 driver

**Files:**
- Create: `src/platform/storage/r2.ts`
- Create: `src/platform/storage/r2.test.ts`
- Modify: `package.json` (dependencies)

**Interfaces:**
- Consumes: `config.R2_*` from Task 1.
- Produces:
  - `putObject(key: string, bytes: Buffer, contentType: string): Promise<void>`
  - `getObject(key: string): Promise<Buffer | null>`
  - `deleteObject(key: string): Promise<void>`
  - `deletePrefix(prefix: string): Promise<void>`
  - `presignPut(key: string, contentType: string, expiresIn: number): Promise<string>`

  Task 3 dispatches to the first four. Task 4 calls `presignPut`.

This task creates the driver but does not wire it up. The application still uses Vercel Blob after this task; Task 3 performs the swap.

- [ ] **Step 1: Install the AWS SDK packages**

Run: `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`

These are server-side only and never reach the client bundle.

- [ ] **Step 2: Write the failing tests**

Create `src/platform/storage/r2.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const send = vi.fn();

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(() => ({ send })),
  PutObjectCommand: vi.fn((input) => ({ kind: "Put", input })),
  GetObjectCommand: vi.fn((input) => ({ kind: "Get", input })),
  DeleteObjectCommand: vi.fn((input) => ({ kind: "Delete", input })),
  DeleteObjectsCommand: vi.fn((input) => ({ kind: "DeleteMany", input })),
  ListObjectsV2Command: vi.fn((input) => ({ kind: "List", input })),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async () => "https://signed.example/put"),
}));

vi.mock("@/platform/config", () => ({
  config: {
    R2_ACCOUNT_ID: "acct123",
    R2_ACCESS_KEY_ID: "akid",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "test-bucket",
  },
}));

import * as r2 from "./r2";

beforeEach(() => {
  send.mockReset();
});

describe("putObject", () => {
  it("writes to the configured bucket under the given key", async () => {
    send.mockResolvedValue({});
    await r2.putObject("branding/logo", Buffer.from("bytes"), "image/png");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input).toMatchObject({
      Bucket: "test-bucket",
      Key: "branding/logo",
      ContentType: "image/png",
    });
  });
});

describe("getObject", () => {
  it("returns the object bytes", async () => {
    send.mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    });
    const bytes = await r2.getObject("cert.pdf");
    expect(bytes).toEqual(Buffer.from([1, 2, 3]));
  });

  it("returns null for a missing key rather than throwing", async () => {
    // Callers treat null as "not found" and render a 404. A thrown NoSuchKey
    // would 500 the route instead.
    send.mockRejectedValue(Object.assign(new Error("nope"), { name: "NoSuchKey" }));
    expect(await r2.getObject("gone.pdf")).toBeNull();
  });

  it("returns null on a bare 404 with no error name", async () => {
    send.mockRejectedValue(
      Object.assign(new Error("nope"), { $metadata: { httpStatusCode: 404 } })
    );
    expect(await r2.getObject("gone.pdf")).toBeNull();
  });

  it("rethrows a genuine failure so it is not mistaken for a missing file", async () => {
    // A 500 or a credentials error must not masquerade as "file not found",
    // which would silently render an empty state over a real outage.
    send.mockRejectedValue(
      Object.assign(new Error("boom"), { $metadata: { httpStatusCode: 500 } })
    );
    await expect(r2.getObject("cert.pdf")).rejects.toThrow("boom");
  });
});

describe("deleteObject", () => {
  it("deletes the key", async () => {
    send.mockResolvedValue({});
    await r2.deleteObject("cert.pdf");
    expect(send.mock.calls[0][0].input).toMatchObject({
      Bucket: "test-bucket",
      Key: "cert.pdf",
    });
  });

  it("swallows a missing key", async () => {
    send.mockRejectedValue(Object.assign(new Error("nope"), { name: "NoSuchKey" }));
    await expect(r2.deleteObject("gone.pdf")).resolves.toBeUndefined();
  });
});

describe("deletePrefix", () => {
  it("pages through every result and batch-deletes each page", async () => {
    // R2 returns at most 1000 keys per list call. A SCORM package can exceed
    // that, so a single unpaged list would leave stale files behind.
    send
      .mockResolvedValueOnce({
        Contents: [{ Key: "scorm/c1/a.html" }, { Key: "scorm/c1/b.js" }],
        IsTruncated: true,
        NextContinuationToken: "page2",
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Contents: [{ Key: "scorm/c1/c.css" }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({});

    await r2.deletePrefix("scorm/c1/");

    const lists = send.mock.calls.filter((c) => c[0].kind === "List");
    const deletes = send.mock.calls.filter((c) => c[0].kind === "DeleteMany");
    expect(lists).toHaveLength(2);
    expect(lists[1][0].input.ContinuationToken).toBe("page2");
    expect(deletes).toHaveLength(2);
    expect(deletes[0][0].input.Delete.Objects).toEqual([
      { Key: "scorm/c1/a.html" },
      { Key: "scorm/c1/b.js" },
    ]);
  });

  it("issues no delete call when the prefix is empty", async () => {
    send.mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    await r2.deletePrefix("scorm/empty/");
    expect(send.mock.calls.filter((c) => c[0].kind === "DeleteMany")).toHaveLength(0);
  });
});

describe("presignPut", () => {
  it("signs a PUT carrying the bucket, key, and content type", async () => {
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const url = await r2.presignPut("scorm-uploads/c1/pkg.zip", "application/zip", 600);
    expect(url).toBe("https://signed.example/put");
    const [, command, options] = vi.mocked(getSignedUrl).mock.calls[0];
    expect((command as unknown as { input: unknown }).input).toMatchObject({
      Bucket: "test-bucket",
      Key: "scorm-uploads/c1/pkg.zip",
      ContentType: "application/zip",
    });
    expect(options).toEqual({ expiresIn: 600 });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/platform/storage/r2.test.ts`
Expected: FAIL, cannot resolve `./r2`.

- [ ] **Step 4: Write the driver**

Create `src/platform/storage/r2.ts`:

```ts
/**
 * Cloudflare R2 driver, spoken over R2's S3-compatible API.
 *
 * Used in every deployed environment. Local dev, CI, and the test suite use the
 * disk driver instead (./disk.ts); selection happens in ./index.ts, which also
 * validates prefixes before they reach deletePrefix here.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "@/platform/config";

let client: S3Client | null = null;

/** Lazily built so importing this module never requires credentials. */
function s3(): S3Client {
  if (client) return client;
  client = new S3Client({
    // R2 has no regions. The SDK requires the field, and "auto" is what
    // Cloudflare documents.
    region: "auto",
    endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID as string,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY as string,
    },
    // AWS SDK v3 sends integrity checksums by default. That breaks presigned
    // PUTs against R2: the signature covers a checksum header the browser never
    // reproduces, so the upload fails with SignatureDoesNotMatch. Send them only
    // where the operation genuinely requires one.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return client;
}

function bucket(): string {
  return config.R2_BUCKET as string;
}

/**
 * A missing object is a null, not an error. R2 answers GetObject with NoSuchKey
 * and some paths with a bare 404, so check the name and the status code. Any
 * other failure is rethrown: a 500 or a credentials error must never be
 * mistaken for "file not found", which would render an empty state over a real
 * outage.
 */
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

/** Store bytes under `key`, overwriting any existing object at that key. */
export async function putObject(
  key: string,
  bytes: Buffer,
  contentType: string
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: bytes,
      ContentType: contentType,
    })
  );
}

/** Read bytes stored under `key`, or null when the object is missing. */
export async function getObject(key: string): Promise<Buffer | null> {
  try {
    const result = await s3().send(
      new GetObjectCommand({ Bucket: bucket(), Key: key })
    );
    if (!result.Body) return null;
    return Buffer.from(await result.Body.transformToByteArray());
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Delete the object stored under `key`. Missing objects are a no-op. */
export async function deleteObject(key: string): Promise<void> {
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
}

/**
 * Delete every object under `prefix`.
 *
 * ListObjectsV2 returns at most 1000 keys per call and an unzipped SCORM package
 * can exceed that, so this pages to exhaustion. The caller (./index.ts) has
 * already validated the prefix against the storage-namespace allowlist.
 */
export async function deletePrefix(prefix: string): Promise<void> {
  let token: string | undefined;
  do {
    const page = await s3().send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    const keys = (page.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => Boolean(key));
    if (keys.length > 0) {
      await s3().send(
        new DeleteObjectsCommand({
          Bucket: bucket(),
          Delete: { Objects: keys.map((Key) => ({ Key })) },
        })
      );
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

/**
 * Sign a PUT so a browser can upload straight to R2, bypassing the 4.5 MB Vercel
 * function request-body limit. `contentType` is part of the signature: the
 * caller must send exactly this value as the Content-Type header or R2 rejects
 * the upload with SignatureDoesNotMatch.
 */
export function presignPut(
  key: string,
  contentType: string,
  expiresIn: number
): Promise<string> {
  return getSignedUrl(
    s3(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
    { expiresIn }
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/platform/storage/r2.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/platform/storage/r2.ts src/platform/storage/r2.test.ts
git commit -m "feat(storage): add the Cloudflare R2 driver"
```

---

### Task 3: Split the storage module and cut over to R2

**Files:**
- Create: `src/platform/storage/disk.ts`
- Create: `src/platform/storage/disk.test.ts`
- Create: `src/platform/storage/index.ts`
- Delete: `src/platform/storage.ts`
- Modify: `src/app/(app)/learning/manage/[courseId]/page.tsx:16,113`
- Modify: `scripts/import-certificates.ts:8,20,61`
- Modify: `scripts/seed-ux-audit-fixtures.ts:28,132-147`

**Interfaces:**
- Consumes: `putObject` / `getObject` / `deleteObject` / `deletePrefix` from `./r2` (Task 2).
- Produces: the unchanged public API of `@/platform/storage`, plus `usingRemoteStorage: boolean` (replacing `usingBlobStorage`).

**This is the cutover.** After it, Vercel Blob is no longer read or written by the application.

Note that `usingBlobStorage` has **three** consumers, two of which are safety guards whose error text names `BLOB_READ_WRITE_TOKEN`. Stale text there would send an operator hunting for a variable the app no longer reads, so the messages change with the rename.

- [ ] **Step 1: Write the failing disk-driver tests**

The disk driver has no test coverage today, and the code being moved includes a path-traversal guard. Create `src/platform/storage/disk.test.ts`:

```ts
import { describe, expect, it, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "@/platform/config";
import * as disk from "./disk";

const root = path.resolve(config.UPLOAD_DIR);

afterEach(async () => {
  await fs.rm(path.join(root, "unit"), { recursive: true, force: true });
});

describe("putObject / getObject", () => {
  it("round-trips bytes through a nested key", async () => {
    await disk.putObject("unit/nested/file.txt", Buffer.from("hello"), "text/plain");
    expect(await disk.getObject("unit/nested/file.txt")).toEqual(Buffer.from("hello"));
  });

  it("returns null for a missing key", async () => {
    expect(await disk.getObject("unit/absent.txt")).toBeNull();
  });

  it("overwrites an existing object at the same key", async () => {
    await disk.putObject("unit/f.txt", Buffer.from("one"), "text/plain");
    await disk.putObject("unit/f.txt", Buffer.from("two"), "text/plain");
    expect(await disk.getObject("unit/f.txt")).toEqual(Buffer.from("two"));
  });
});

describe("path traversal", () => {
  // Keys reach this driver from user-influenced values. Escaping UPLOAD_DIR
  // would let a caller read or clobber arbitrary files on the host.
  it("refuses to write outside the upload dir", async () => {
    await expect(
      disk.putObject("../../escaped.txt", Buffer.from("x"), "text/plain")
    ).rejects.toThrow(/outside the upload dir/);
  });

  it("refuses to write to an absolute key", async () => {
    await expect(
      disk.putObject("/tmp/escaped.txt", Buffer.from("x"), "text/plain")
    ).rejects.toThrow(/outside the upload dir/);
  });

  it("refuses to delete outside the upload dir", async () => {
    await expect(disk.deleteObject("../../escaped.txt")).rejects.toThrow(
      /outside the upload dir/
    );
  });

  it("reads a traversing key as a miss rather than throwing", async () => {
    // Deliberately null, not a throw. Serving routes turn null into a 404; a
    // throw would 500 instead, and would also disagree with the R2 driver,
    // where an unreachable key is simply a miss.
    expect(await disk.getObject("../../etc/passwd")).toBeNull();
  });

  it("allows a key that merely contains dots in a segment name", async () => {
    await disk.putObject("unit/a..b.txt", Buffer.from("ok"), "text/plain");
    expect(await disk.getObject("unit/a..b.txt")).toEqual(Buffer.from("ok"));
  });
});

describe("deleteObject", () => {
  it("removes the object", async () => {
    await disk.putObject("unit/gone.txt", Buffer.from("x"), "text/plain");
    await disk.deleteObject("unit/gone.txt");
    expect(await disk.getObject("unit/gone.txt")).toBeNull();
  });

  it("is a no-op for a missing object", async () => {
    await expect(disk.deleteObject("unit/never.txt")).resolves.toBeUndefined();
  });
});

describe("deletePrefix", () => {
  it("removes every object under the prefix", async () => {
    await disk.putObject("unit/tree/a.txt", Buffer.from("a"), "text/plain");
    await disk.putObject("unit/tree/deep/b.txt", Buffer.from("b"), "text/plain");
    await disk.deletePrefix("unit/tree/");
    expect(await disk.getObject("unit/tree/a.txt")).toBeNull();
    expect(await disk.getObject("unit/tree/deep/b.txt")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/platform/storage/disk.test.ts`
Expected: FAIL, cannot resolve `./disk`.

- [ ] **Step 3: Write the disk driver**

Create `src/platform/storage/disk.ts`. This is the existing local-filesystem code moved verbatim, minus the Blob branches:

```ts
/**
 * Local filesystem driver. The default for local dev, CI, and the test suite.
 * Files are written under config.UPLOAD_DIR. Deployed environments use the R2
 * driver instead (./r2.ts); selection happens in ./index.ts.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { config } from "@/platform/config";

/** Resolve a storage key to an absolute disk path, refusing traversal escapes. */
function localPath(key: string): string {
  const root = path.resolve(config.UPLOAD_DIR);
  const resolved = path.resolve(root, key);
  // The resolved path must stay inside `root`. Compute the path relative to the
  // root: anything that escapes produces a leading ".." segment or an absolute
  // path (a different drive on Windows), both of which we reject.
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to access path outside the upload dir: ${key}`);
  }
  return resolved;
}

/** Store bytes under `key`, overwriting any existing object at that key. */
export async function putObject(
  key: string,
  bytes: Buffer,
  _contentType: string
): Promise<void> {
  // Content type is not persisted on disk: the serving routes already derive it
  // from the database row or the file extension.
  const diskPath = localPath(key);
  await fs.mkdir(path.dirname(diskPath), { recursive: true });
  await fs.writeFile(diskPath, bytes);
}

/**
 * Read bytes stored under `key`, or null when the object is missing.
 *
 * localPath is called INSIDE the try on purpose: a traversing key reads as a
 * miss, not an exception. Serving routes turn null into a 404, and the R2 driver
 * likewise answers an unreachable key with null, so the two drivers agree.
 */
export async function getObject(key: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(localPath(key));
  } catch {
    return null;
  }
}

/** Delete the object stored under `key`. Missing objects are a no-op. */
export async function deleteObject(key: string): Promise<void> {
  await fs.rm(localPath(key), { force: true }).catch(() => undefined);
}

/** Delete every object stored under `prefix`, which maps to a directory. */
export async function deletePrefix(prefix: string): Promise<void> {
  const dir = localPath(prefix.replace(/\/$/, ""));
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
```

This is a move, not a rewrite. Behavior is byte-for-byte what it is today, including the asymmetry the tests above pin down: `putObject`, `deleteObject`, and `deletePrefix` throw on a traversing key, while `getObject` returns `null`. Do not "fix" that asymmetry here. Making `getObject` throw would turn 404s into 500s on the routes that serve user-supplied keys, and would make the disk driver disagree with R2, where an unreachable key is simply a miss.

If eslint objects to the unused `_contentType` parameter, check `argsIgnorePattern` in the eslint config before changing the signature. The parameter has to stay for the drivers to share one shape.

- [ ] **Step 4: Run the disk tests to verify they pass**

Run: `npx vitest run src/platform/storage/disk.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Write the public module**

Create `src/platform/storage/index.ts`:

```ts
/**
 * File storage abstraction for uploaded artifacts (HIPAA certificates,
 * recruitment application files, onboarding documents, incident and support
 * attachments, branding images, unzipped SCORM package trees).
 *
 * Two drivers, selected at runtime:
 *   - Cloudflare R2 -- used when the R2_* variables are set (every deployed
 *                      environment). Vercel's function filesystem is
 *                      read-only/ephemeral, so disk storage does not persist there.
 *   - Local disk    -- the default for local dev, CI, and the test suite. Files
 *                      are written under config.UPLOAD_DIR.
 *
 * Callers pass a stable `key` (a relative path such as "<certId>.pdf" or
 * "recruitment/<cycleId>/<storedName>"). The same key round-trips through both
 * drivers, so DB-stored `storedName` values keep working unchanged.
 *
 * The R2 driver is loaded dynamically so the AWS SDK is never pulled into
 * environments that do not use it.
 */
import { config } from "@/platform/config";
import * as disk from "./disk";

/**
 * True when bytes live in a remote store rather than on this machine.
 *
 * config.ts enforces that the R2 variables are all set or all unset, so testing
 * one is sufficient. Two scripts guard on this flag: import-certificates refuses
 * to write rows to a remote database while bytes go to local disk, and
 * seed-ux-audit-fixtures refuses to write throwaway fixtures into a shared store.
 */
export const usingRemoteStorage = Boolean(config.R2_BUCKET);

/** Store bytes under `key`, overwriting any existing object at that key. */
export async function putObject(
  key: string,
  bytes: Buffer,
  contentType: string
): Promise<void> {
  if (usingRemoteStorage) {
    const r2 = await import("./r2");
    return r2.putObject(key, bytes, contentType);
  }
  return disk.putObject(key, bytes, contentType);
}

/** Read bytes stored under `key`, or null when the object is missing. */
export async function getObject(key: string): Promise<Buffer | null> {
  if (usingRemoteStorage) {
    const r2 = await import("./r2");
    return r2.getObject(key);
  }
  return disk.getObject(key);
}

/** Delete the object stored under `key`. Missing objects are a no-op. */
export async function deleteObject(key: string): Promise<void> {
  if (usingRemoteStorage) {
    const r2 = await import("./r2");
    return r2.deleteObject(key);
  }
  return disk.deleteObject(key);
}

/**
 * Delete every object stored under `prefix` (e.g. "scorm/<courseId>/"). Used when
 * replacing a SCORM package so stale files from the previous upload don't linger.
 */
export async function deletePrefix(prefix: string): Promise<void> {
  // Allowlist the prefix to our own storage namespace before it reaches any path
  // or list operation: slash-separated segments of safe chars only. This rejects
  // "..", absolute paths, and backslashes outright (our prefixes are "scorm/<id>/").
  if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\/?$/.test(prefix)) {
    throw new Error(`Refusing unsafe storage prefix: ${prefix}`);
  }
  if (usingRemoteStorage) {
    const r2 = await import("./r2");
    return r2.deletePrefix(prefix);
  }
  return disk.deletePrefix(prefix);
}
```

- [ ] **Step 6: Delete the old module**

```bash
git rm src/platform/storage.ts
```

- [ ] **Step 7: Rename the flag at its three consumers**

In `src/app/(app)/learning/manage/[courseId]/page.tsx`, line 16 and line 113:

```tsx
import { usingRemoteStorage } from "@/platform/storage";
```

```tsx
          <UploadPackageForm courseId={course.id} hasPackage={course.scormEntryHref != null} usingRemoteStorage={usingRemoteStorage} />
```

In `scripts/import-certificates.ts`, update the import on line 8, the guard on line 20, and the message on line 61:

```ts
import { usingRemoteStorage } from "@/platform/storage";
```

```ts
  if (usingRemoteStorage) return; // R2 is configured -- bytes go where the rows go.
```

```ts
      : `Apply mode -- writing to database and ${usingRemoteStorage ? "Cloudflare R2" : "local disk"}.`
```

Also update the doc comment above `assertStorageMatchesDatabase` so it names the right variable:

```ts
/**
 * Guard against the footgun that orphaned every imported certificate once:
 * running against a REMOTE database (e.g. prod Neon) while storage silently
 * falls back to LOCAL DISK because the R2_* variables are unset. The DB rows
 * land in prod, the bytes land on this laptop, and downloads 404 forever.
 */
```

In `scripts/seed-ux-audit-fixtures.ts`, update the import on line 28 and rewrite the guard so its text names R2:

```ts
import { putObject, deleteObject, usingRemoteStorage } from "@/platform/storage";
```

```ts
/**
 * Refuse to run with real remote storage configured.
 *
 * `assertAuditDatabase` only guards the database. `usingRemoteStorage` picks
 * Cloudflare R2 over local disk based on the R2_* variables alone, with no
 * per-database scoping, so a developer with real credentials would pass the
 * database guard and then write fixture PDFs, and on the rebuild path run
 * `deleteObject` against them, in the shared R2 bucket rather than a throwaway one.
 */
function assertLocalStorage(): void {
  if (usingRemoteStorage) {
    throw new Error(
      "Refusing to build audit fixtures with R2 storage configured. This script " +
        "writes fixture PDFs, and deletes them again on rebuild, under keys that would " +
        "land in the real R2 bucket instead of a throwaway one. Unset R2_BUCKET " +
        "so storage falls back to local disk.",
    );
  }
}
```

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: PASS. This is the main regression signal for the refactor: all 24 consumers exercise the disk driver through the unchanged public API.

If `src/app/(app)/learning/play/[courseId]/[...path]/route.test.ts` or `src/app/api/recruitment/onboarding/[contractId]/hipaa/route.test.ts` fail, check their `vi.mock("@/platform/storage")` calls still resolve. The specifier is unchanged (a directory with an `index.ts` resolves identically), so they should need no edit.

- [ ] **Step 9: Typecheck and lint**

Run: `npm run typecheck && npx eslint src e2e scripts`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add -A src/platform/storage src/app scripts
git commit -m "refactor(storage): split into disk and R2 drivers, cut over from Blob"
```

---

### Task 4: Presigned upload URL route

**Files:**
- Create: `src/app/api/learning/upload-url/route.ts`
- Create: `src/app/api/learning/upload-url/route.test.ts`
- Delete: `src/app/api/learning/blob-upload/route.ts`
- Create: `docs/runbooks/r2-bucket-setup.md`

**Interfaces:**
- Consumes: `presignPut(key, contentType, expiresIn)` from `src/platform/storage/r2.ts` (Task 2).
- Produces: `POST /api/learning/upload-url` accepting `{ courseId: string, filename: string, contentType: string, size: number }` and returning `{ url: string, key: string }` on success or `{ error: string }` with status 400 or 403. Task 5 calls it.

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/learning/upload-url/route.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const auth = vi.fn();
const getActivePerson = vi.fn();
const can = vi.fn();
const presignPut = vi.fn();

vi.mock("@/platform/auth/auth", () => ({ auth }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson }));
vi.mock("@/platform/rbac/engine", () => ({ can }));
vi.mock("@/platform/storage/r2", () => ({ presignPut }));

import { POST } from "./route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/learning/upload-url", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const valid = {
  courseId: "course-1",
  filename: "package.zip",
  contentType: "application/zip",
  size: 1024,
};

beforeEach(() => {
  auth.mockReset().mockResolvedValue({ personId: "p1" });
  getActivePerson.mockReset().mockResolvedValue({ id: "p1" });
  can.mockReset().mockResolvedValue(true);
  presignPut.mockReset().mockResolvedValue("https://signed.example/put");
});

describe("POST /api/learning/upload-url", () => {
  it("returns a signed URL and key for a course manager", async () => {
    const res = await POST(request(valid));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.url).toBe("https://signed.example/put");
    expect(json.key).toMatch(/^scorm-uploads\/course-1\/[0-9a-f-]+-package\.zip$/);
  });

  it("signs with the same content type the client will send", async () => {
    // A mismatch between the signed ContentType and the PUT header fails with
    // SignatureDoesNotMatch, which surfaces to the user as an opaque 403.
    await POST(request(valid));
    expect(presignPut).toHaveBeenCalledWith(
      expect.stringContaining("scorm-uploads/course-1/"),
      "application/zip",
      600
    );
  });

  it("rejects an anonymous caller", async () => {
    auth.mockResolvedValue(null);
    const res = await POST(request(valid));
    expect(res.status).toBe(403);
    expect(presignPut).not.toHaveBeenCalled();
  });

  it("rejects a signed-in user without learning.manage_courses", async () => {
    can.mockResolvedValue(false);
    const res = await POST(request(valid));
    expect(res.status).toBe(403);
    expect(presignPut).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared size", async () => {
    const res = await POST(request({ ...valid, size: 80 * 1024 * 1024 }));
    expect(res.status).toBe(400);
    expect(presignPut).not.toHaveBeenCalled();
  });

  it("rejects a disallowed content type", async () => {
    const res = await POST(request({ ...valid, contentType: "text/html" }));
    expect(res.status).toBe(400);
    expect(presignPut).not.toHaveBeenCalled();
  });

  it("rejects a courseId that could escape the key namespace", async () => {
    // courseId is interpolated straight into the object key. A traversal value
    // would let a manager write outside scorm-uploads/.
    const res = await POST(request({ ...valid, courseId: "../../branding" }));
    expect(res.status).toBe(400);
    expect(presignPut).not.toHaveBeenCalled();
  });

  it("sanitizes a hostile filename into the key", async () => {
    const res = await POST(request({ ...valid, filename: "../../etc/passwd" }));
    expect(res.status).toBe(200);
    const { key } = await res.json();
    expect(key).not.toContain("..");
    expect(key.startsWith("scorm-uploads/course-1/")).toBe(true);
  });

  it("rejects a malformed body", async () => {
    const res = await POST(request({ courseId: "course-1" }));
    expect(res.status).toBe(400);
    expect(presignPut).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/api/learning/upload-url/route.test.ts`
Expected: FAIL, cannot resolve `./route`.

- [ ] **Step 3: Write the route**

Create `src/app/api/learning/upload-url/route.ts`:

```ts
import { randomUUID } from "node:crypto";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { can } from "@/platform/rbac/engine";
import { presignPut } from "@/platform/storage/r2";

/** Max COMPRESSED upload size. Mirrors the client-side check in UploadPackageForm. */
const MAX_UPLOAD_BYTES = 75 * 1024 * 1024; // 75 MB

/** Browsers disagree about the zip MIME type, so accept the three we see. */
const ALLOWED_CONTENT_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
]);

/** Long enough for a slow 75 MB upload, short enough that a leaked URL ages out. */
const EXPIRES_IN_SECONDS = 600;

/**
 * Reduce a browser-supplied filename to safe key characters. The uploaded name
 * is cosmetic (ingest reads the key, not the name), so replacing rather than
 * rejecting keeps unicode filenames working.
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "package.zip";
}

type Body = {
  courseId?: unknown;
  filename?: unknown;
  contentType?: unknown;
  size?: unknown;
};

function bad(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/**
 * POST /api/learning/upload-url
 *
 * Issues a short-lived presigned PUT URL so a course manager's browser can send a
 * SCORM .zip DIRECTLY to R2, bypassing the 4.5 MB Vercel function request-body
 * limit. The browser then calls ingestUploadedPackageAction with the returned
 * key; the server unzips it from storage. Only learning.manage_courses holders
 * can obtain a URL.
 *
 * A presigned PUT cannot itself cap the request body, so size is defended in
 * three layers: the client checks before asking, this route checks the declared
 * size before signing, and ingest checks the actual object before unzipping.
 */
export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return bad("Malformed request body.", 400);
  }

  const { courseId, filename, contentType, size } = body;
  if (
    typeof courseId !== "string" ||
    typeof filename !== "string" ||
    typeof contentType !== "string" ||
    typeof size !== "number" ||
    !Number.isFinite(size)
  ) {
    return bad("Malformed request body.", 400);
  }

  // courseId is interpolated straight into the object key, so it has to be
  // constrained to key-safe characters before it gets there.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(courseId)) {
    return bad("Invalid course reference.", 400);
  }
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return bad("Upload a .zip SCORM package.", 400);
  }
  if (size <= 0 || size > MAX_UPLOAD_BYTES) {
    return bad("That package is too large (max 75 MB).", 400);
  }

  const session = await auth();
  if (!session?.personId) return bad("Unauthorized", 403);
  const person = await getActivePerson(session.personId);
  if (!person || !(await can(person.id, "learning.manage_courses"))) {
    return bad("Unauthorized", 403);
  }

  const key = `scorm-uploads/${courseId}/${randomUUID()}-${sanitizeFilename(filename)}`;
  const url = await presignPut(key, contentType, EXPIRES_IN_SECONDS);
  return Response.json({ url, key });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app/api/learning/upload-url/route.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Delete the Blob route**

```bash
git rm src/app/api/learning/blob-upload/route.ts
```

- [ ] **Step 6: Write the bucket setup runbook**

Create `docs/runbooks/r2-bucket-setup.md`:

````markdown
# R2 bucket setup

One bucket per environment: `havenhub-uploads` for production, and
`havenhub-uploads-preview` for preview deployments. Keeping preview separate
means a preview branch can never write into or delete production files.

## 1. Create the buckets

Cloudflare dashboard, R2 > Create bucket. Standard storage class. No public
access: every read in the application is proxied through an authenticated route
handler, and a public bucket would expose HIPAA certificates.

## 2. Create an API token

R2 > Manage API tokens > Create token, with **Object Read & Write** permission
scoped to the two buckets. Record the Access Key ID and Secret Access Key; the
secret is shown once.

## 3. CORS rule

Required, and its absence is the single most confusing failure in this setup:
without it the browser SCORM upload fails with an opaque CORS error that looks
nothing like a configuration problem.

Bucket > Settings > CORS policy, on **both** buckets:

```json
[
  {
    "AllowedOrigins": [
      "https://hub.havenfreeclinic.org",
      "https://apply.havenfreeclinic.org",
      "http://localhost:3000"
    ],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

Add any preview domain you upload from. `AllowedHeaders` must include
`content-type`, because the presigned PUT signs that header and the browser
sends it.

## 4. Environment variables

Set on the Vercel project, production and preview scoped separately so preview
points at the preview bucket:

| Variable | Value |
| --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare account ID (R2 overview page) |
| `R2_ACCESS_KEY_ID` | from step 2 |
| `R2_SECRET_ACCESS_KEY` | from step 2 |
| `R2_BUCKET` | `havenhub-uploads` or `havenhub-uploads-preview` |

All four are required together. A partial configuration is rejected at boot
rather than silently falling back to the ephemeral local disk.
````

- [ ] **Step 7: Lint and commit**

```bash
npx eslint src scripts
git add -A src/app/api/learning docs/runbooks/r2-bucket-setup.md
git commit -m "feat(learning): issue presigned R2 PUT URLs for SCORM uploads"
```

---

### Task 5: Client upload via presigned PUT

**Files:**
- Modify: `src/app/(app)/learning/manage/[courseId]/UploadPackageForm.tsx`
- Modify: `src/app/(app)/learning/manage/actions.ts:107-149`

**Interfaces:**
- Consumes: `POST /api/learning/upload-url` returning `{ url, key }` (Task 4).
- Produces: `ingestUploadedPackageAction({ courseId, key, resetProgress })`. The `pathname` parameter is renamed to `key`, dropping Vercel Blob vocabulary from the last place it appears.

- [ ] **Step 1: Rename the action parameter**

In `src/app/(app)/learning/manage/actions.ts`, rename the helper and the field. Replace lines 107 to 113:

```ts
/** Reject an upload key that does not belong to this course's staging namespace. */
function safeUploadKey(key: string, courseId: string): string {
  const norm = key.replace(/^\/+/, "");
  if (!norm.startsWith(`scorm-uploads/${courseId}/`) || norm.split("/").some((s) => s === "..")) {
    throw new LearningValidationError("Invalid upload reference.");
  }
  return norm;
}
```

Then update the doc comment and signature (lines 115 to 130):

```ts
/**
 * Ingest a SCORM package the browser already uploaded directly to R2 (the path
 * used on Vercel, where the function request body is capped at 4.5 MB). We read
 * the object's bytes through the storage abstraction by key (no fetch of a
 * client URL), ingest, then delete the transient upload.
 */
export async function ingestUploadedPackageAction(input: {
  courseId: string;
  key: string;
  resetProgress?: boolean;
}): Promise<UploadState> {
  const person = await requirePermission("learning.manage_courses");

  let key: string;
  try {
    key = safeUploadKey(input.key, input.courseId);
```

- [ ] **Step 2: Enforce the actual object size before unzipping**

This is the third layer of the size defense described in the spec, and the only one that sees the real object rather than a client-declared number. A presigned PUT cannot cap the request body, so without this a course manager could sign a URL for a 1 KB upload and then PUT 500 MB through it.

Add the constant near the top of `src/app/(app)/learning/manage/actions.ts`:

```ts
/** Max COMPRESSED package size. Mirrors the presign route and the client check. */
const MAX_UPLOAD_BYTES = 75 * 1024 * 1024; // 75 MB
```

Then in `ingestUploadedPackageAction`, between reading the bytes and ingesting them:

```ts
    const bytes = await getObject(key);
    if (!bytes) return { error: "Could not read the uploaded package from storage." };
    // The presigned URL capped nothing: it was signed against a size the client
    // declared, not the bytes it actually sent. This is the first look at the
    // real object, so check it before handing anything to the unzipper.
    if (bytes.length > MAX_UPLOAD_BYTES) {
      return { error: "That package is too large (max 75 MB)." };
    }
    await ingestScormPackage(input.courseId, bytes, person.personId, { resetProgress: !!input.resetProgress });
```

The `finally` block already deletes the transient upload, so an oversized object is cleaned up on the way out.

- [ ] **Step 3: Rewrite the direct-upload form**

In `src/app/(app)/learning/manage/[courseId]/UploadPackageForm.tsx`, replace the `@vercel/blob/client` import (line 4) with nothing, and add the upload helper above `UploadPackageForm`:

```tsx
/**
 * PUT a file to a presigned R2 URL, reporting progress.
 *
 * XMLHttpRequest rather than fetch: fetch exposes no upload-progress event, and
 * a 75 MB SCORM package needs a live percentage or the form looks hung.
 */
function putWithProgress(
  url: string,
  file: File,
  contentType: string,
  onProgress: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    // Must match the content type the URL was signed with, or R2 rejects the
    // upload with SignatureDoesNotMatch.
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () =>
      reject(new Error("Upload failed. Check your connection and try again."));
    xhr.send(file);
  });
}
```

Update the props and the top-level switch:

```tsx
/**
 * SCORM package upload. On Vercel (R2 configured) the browser uploads the .zip
 * DIRECTLY to R2 via a presigned URL and then asks the server to ingest it --
 * this bypasses the 4.5 MB Vercel function request-body limit that a plain
 * Server Action upload hits (FUNCTION_PAYLOAD_TOO_LARGE). In local dev (no R2)
 * it falls back to a normal Server Action form, which has no such limit.
 */
export function UploadPackageForm({
  courseId,
  hasPackage,
  usingRemoteStorage,
}: FormProps & { usingRemoteStorage: boolean }) {
  return usingRemoteStorage ? (
    <DirectUploadForm courseId={courseId} hasPackage={hasPackage} />
  ) : (
    <ServerActionUploadForm courseId={courseId} hasPackage={hasPackage} />
  );
}
```

Rename `BlobUploadForm` to `DirectUploadForm`, keeping its doc comment accurate:

```tsx
/** Direct-to-R2 path (Vercel). */
function DirectUploadForm({ courseId, hasPackage }: FormProps) {
```

Replace the body of `onSubmit`'s `try` block (lines 74 to 88 in the original) with:

```tsx
      const contentType = "application/zip";
      setPhase("Preparing…");
      const signed = await fetch("/api/learning/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId,
          filename: file.name,
          contentType,
          size: file.size,
        }),
      });
      if (!signed.ok) {
        const body = (await signed.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not start the upload. Please try again.");
        return;
      }
      const { url, key } = (await signed.json()) as { url: string; key: string };
      setPhase("Uploading… 0%");
      await putWithProgress(url, file, contentType, (percent) =>
        setPhase(`Uploading… ${Math.round(percent)}%`)
      );
      setPhase("Processing…");
      const res = await ingestUploadedPackageAction({ courseId, key, resetProgress });
      if (res?.error) {
        setError(res.error);
        return;
      }
      router.refresh();
```

The `catch` branch and its `console.error` are unchanged.

- [ ] **Step 4: Run the learning tests**

Run: `npx vitest run src/modules/learning src/app/\(app\)/learning`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If `ingestUploadedPackageAction` still has a `pathname` caller anywhere, this is where it surfaces.

- [ ] **Step 6: Verify Vercel Blob is gone from application code**

Run: `grep -rn "@vercel/blob" --include="*.ts" --include="*.tsx" src`
Expected: no matches. The only remaining reference will be the backfill script added in Task 6.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint src
git add "src/app/(app)/learning"
git commit -m "feat(learning): upload SCORM packages to R2 via presigned PUT"
```

---

### Task 6: Backfill script

**Files:**
- Create: `scripts/migrate-blob-to-r2.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `@vercel/blob` (`list`, `head`, `get`) for the source, `putObject` and `getObject` from `src/platform/storage/r2.ts` for the destination.
- Produces: `npm run migrate:r2:dry` and `npm run migrate:r2:apply`.

This script is the **only** remaining importer of `@vercel/blob` after Task 5. It is deleted together with the dependency once the cutover is verified.

- [ ] **Step 1: Write the script**

Create `scripts/migrate-blob-to-r2.ts`:

```ts
// One-off migration of every object from Vercel Blob to Cloudflare R2.
// Dry-run by default:
//   npx tsx --env-file=.env scripts/migrate-blob-to-r2.ts
//   npx tsx --env-file=.env scripts/migrate-blob-to-r2.ts --apply
//
// Keys round-trip unchanged: putObject has always written with
// addRandomSuffix:false, so a Blob pathname already IS the storage key and no
// database row has to change.
//
// Safe to re-run. Objects already present in R2 at the same size are skipped, so
// an interrupted run resumes, and a second pass after the deploy sweeps anything
// written during the cutover window.
import { list, head, get } from "@vercel/blob";
import { config } from "@/platform/config";
import { putObject, getObject } from "@/platform/storage/r2";

const apply = process.argv.includes("--apply");

/**
 * Transient SCORM staging uploads. These were written with addRandomSuffix:true
 * as short-lived input to ingest, are deleted by the ingest action, and are
 * referenced by no database row. Copying them would waste the R2 budget on
 * garbage.
 */
const SKIP_PREFIX = "scorm-uploads/";

type Stats = {
  copied: number;
  skippedExisting: number;
  skippedTransient: number;
  failed: number;
  bytes: number;
};

function requireConfig(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN is required to read the source store. Set it to the " +
        "Vercel Blob token for the environment you are migrating FROM."
    );
  }
  if (!config.R2_BUCKET) {
    throw new Error(
      "R2_BUCKET is unset, so there is no destination. Set all four R2_* variables " +
        "to the bucket you are migrating TO."
    );
  }
  return token;
}

/** True when R2 already holds this key with the same byte length. */
async function alreadyPresent(key: string, size: number): Promise<boolean> {
  const existing = await getObject(key);
  return existing !== null && existing.length === size;
}

async function copyOne(
  key: string,
  size: number,
  token: string,
  stats: Stats
): Promise<void> {
  if (key.startsWith(SKIP_PREFIX)) {
    stats.skippedTransient++;
    return;
  }
  if (await alreadyPresent(key, size)) {
    stats.skippedExisting++;
    return;
  }
  if (!apply) {
    console.log(`  would copy ${key} (${size} bytes)`);
    stats.copied++;
    stats.bytes += size;
    return;
  }
  try {
    const meta = await head(key, { token });
    const source = await get(key, { access: "private", token });
    if (!source || source.statusCode !== 200) {
      throw new Error(`source read returned ${source?.statusCode ?? "nothing"}`);
    }
    const bytes = Buffer.from(await new Response(source.stream).arrayBuffer());
    await putObject(key, bytes, meta.contentType || "application/octet-stream");
    stats.copied++;
    stats.bytes += bytes.length;
    console.log(`  copied ${key} (${bytes.length} bytes)`);
  } catch (err) {
    stats.failed++;
    console.error(`  FAILED ${key}: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const token = requireConfig();
  console.log(
    apply
      ? `Apply mode -- copying Vercel Blob objects into R2 bucket "${config.R2_BUCKET}".`
      : "Dry run -- no writes. Re-run with --apply to copy."
  );

  const stats: Stats = {
    copied: 0,
    skippedExisting: 0,
    skippedTransient: 0,
    failed: 0,
    bytes: 0,
  };

  let cursor: string | undefined;
  do {
    const page = await list({ cursor, token });
    for (const blob of page.blobs) {
      await copyOne(blob.pathname, blob.size, token, stats);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  console.log("");
  console.log(`Copied:             ${stats.copied}`);
  console.log(`Skipped (in R2):    ${stats.skippedExisting}`);
  console.log(`Skipped (transient):${stats.skippedTransient}`);
  console.log(`Failed:             ${stats.failed}`);
  console.log(`Bytes:              ${stats.bytes}`);

  if (stats.failed > 0) {
    console.error("");
    console.error(
      "Some objects failed. The script is idempotent, so re-run it to retry only " +
        "the ones that are still missing."
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm scripts**

In `package.json`, alongside the other import and backfill entries:

```json
    "migrate:r2:dry": "tsx --env-file=.env scripts/migrate-blob-to-r2.ts",
    "migrate:r2:apply": "tsx --env-file=.env scripts/migrate-blob-to-r2.ts --apply",
```

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npx eslint scripts`
Expected: no errors.

- [ ] **Step 4: Verify the Blob list API shape against the real store**

This step cannot be covered by a unit test and must be run by hand before trusting the script.

Run: `npm run migrate:r2:dry`

Expected: a list of `would copy <key>` lines whose keys look like real storage keys (`<uuid>.pdf`, `recruitment/<cycleId>/<name>`, `scorm/<courseId>/...`, `branding/logo`). If the keys come back with a random suffix appended, or `blob.pathname` is undefined, stop: the `list()` response shape differs from what this script assumes and the mapping needs fixing before any `--apply` run.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-blob-to-r2.ts package.json
git commit -m "feat(scripts): add the Vercel Blob to R2 backfill"
```

---

### Task 7: Cutover runbook

**Files:**
- Create: `docs/runbooks/r2-cutover.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the operator procedure. No code.

- [ ] **Step 1: Write the runbook**

Create `docs/runbooks/r2-cutover.md`:

````markdown
# Cutting over from Vercel Blob to R2

Prerequisite: `docs/runbooks/r2-bucket-setup.md` is complete, so the buckets, the
API token, and the CORS rules exist.

There is a window between the backfill finishing and the new deploy going live in
which a write could still land in Vercel Blob and be missed. Step 5 closes it by
re-running the backfill. Nothing before step 7 is destructive: the Blob store is
untouched throughout, so unsetting the R2 variables and redeploying reverts the
whole cutover.

## 1. Dry-run the backfill

```bash
BLOB_READ_WRITE_TOKEN=<prod blob token> \
R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=havenhub-uploads \
npm run migrate:r2:dry
```

Confirm the key list looks like real storage keys and the object count is
plausible. Nothing is written.

## 2. Run the backfill

Same command with `npm run migrate:r2:apply`. Re-run it if any object fails; the
script skips what it already copied.

## 3. Deploy

Set the four `R2_*` variables on the Vercel project (production scope) and deploy
the branch. The application now reads and writes R2 exclusively.

## 4. Smoke-test

- Open a HIPAA certificate from `/my-info` and confirm the PDF renders.
- Open a course under `/learning` and confirm the SCORM content loads. This
  exercises the per-file read path.
- Upload a replacement SCORM package from `/learning/manage/<courseId>`. Confirm
  the progress percentage advances and ingest succeeds. **A CORS error here means
  the bucket rule from the setup runbook is missing or does not list this origin.**
- Upload a branding logo from `/admin/settings` and confirm it renders.

## 5. Sweep the cutover window

Re-run `npm run migrate:r2:apply`. This copies anything written to Blob between
step 2 and step 3. Expect a small number of objects, or zero.

## 6. Verify

Compare object counts between the Vercel Blob dashboard and the R2 bucket,
allowing for the `scorm-uploads/` staging objects the script deliberately skips.

## 7. Decommission

Only after the above is confirmed, in a follow-up change:

- `npm uninstall @vercel/blob`
- `git rm scripts/migrate-blob-to-r2.ts` and drop its two `package.json` entries
- Remove `BLOB_READ_WRITE_TOKEN` from the Vercel project
- Delete the Vercel Blob store

## Rollback

Before step 7: unset the four `R2_*` variables and redeploy. The Blob store still
holds every object. After step 7 there is no rollback, which is why it is a
separate change.
````

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/r2-cutover.md
git commit -m "docs(storage): add the R2 cutover runbook"
```

---

## Final verification

- [ ] Run the full suite: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Lint the whole repo: `npm run lint`
- [ ] Confirm no application code imports Vercel Blob: `grep -rn "@vercel/blob" --include="*.ts" --include="*.tsx" src` returns nothing
- [ ] Confirm the storage public API is unchanged: `grep -rn "from \"@/platform/storage\"" --include="*.ts" --include="*.tsx" src | wc -l` still returns 24

## What cannot be verified without a real bucket

Two behaviors are integration-only and a mocked test cannot confirm them. Both
must be exercised by hand before merge, via the smoke test in the cutover runbook:

1. **The SDK checksum settings.** `requestChecksumCalculation: "WHEN_REQUIRED"`
   is there to stop the SDK signing a checksum header the browser will not send.
   If it is wrong, presigned PUTs fail with `SignatureDoesNotMatch`.
2. **The bucket CORS rule.** Its absence fails the browser upload with an opaque
   CORS error that looks nothing like a configuration problem.
