import { describe, expect, it, vi, beforeEach } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

// These are constructed with `new` in the driver (matching real AWS SDK usage),
// so the mock implementations must be plain functions -- an arrow function has
// no [[Construct]] and vi.fn() throws "is not a constructor" when `new`'d.
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(function () {
    return { send };
  }),
  PutObjectCommand: vi.fn(function (input) {
    return { kind: "Put", input };
  }),
  GetObjectCommand: vi.fn(function (input) {
    return { kind: "Get", input };
  }),
  HeadObjectCommand: vi.fn(function (input) {
    return { kind: "Head", input };
  }),
  HeadBucketCommand: vi.fn(function (input) {
    return { kind: "HeadBucket", input };
  }),
  DeleteObjectCommand: vi.fn(function (input) {
    return { kind: "Delete", input };
  }),
  DeleteObjectsCommand: vi.fn(function (input) {
    return { kind: "DeleteMany", input };
  }),
  ListObjectsV2Command: vi.fn(function (input) {
    return { kind: "List", input };
  }),
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

describe("headObject", () => {
  it("returns the object size without downloading the body", async () => {
    send.mockResolvedValue({ ContentLength: 4096 });
    const result = await r2.headObject("cert.pdf");
    expect(result).toEqual({ size: 4096 });
    expect(send.mock.calls[0][0]).toMatchObject({
      kind: "Head",
      input: { Bucket: "test-bucket", Key: "cert.pdf" },
    });
  });

  it("returns null for a missing key rather than throwing", async () => {
    send.mockRejectedValue(Object.assign(new Error("nope"), { name: "NoSuchKey" }));
    expect(await r2.headObject("gone.pdf")).toBeNull();
  });

  it("returns null on a bare 404 with no error name", async () => {
    send.mockRejectedValue(
      Object.assign(new Error("nope"), { $metadata: { httpStatusCode: 404 } })
    );
    expect(await r2.headObject("gone.pdf")).toBeNull();
  });

  it("rethrows a genuine failure so it is not mistaken for a missing file", async () => {
    send.mockRejectedValue(
      Object.assign(new Error("boom"), { $metadata: { httpStatusCode: 500 } })
    );
    await expect(r2.headObject("cert.pdf")).rejects.toThrow("boom");
  });
});

describe("bucketExists", () => {
  it("returns true when HeadBucket succeeds", async () => {
    send.mockResolvedValue({});
    expect(await r2.bucketExists()).toBe(true);
    expect(send.mock.calls[0][0]).toMatchObject({
      kind: "HeadBucket",
      input: { Bucket: "test-bucket" },
    });
  });

  it("returns false when the bucket does not exist -- R2's NotFound", async () => {
    // R2 never sends NoSuchBucket (the AWS S3 name); it sends the generic
    // NotFound with a 404, same as a missing key would. HeadBucket takes no
    // key, so a 404 from it unambiguously means the bucket itself is absent.
    send.mockRejectedValue(
      Object.assign(new Error("nope"), {
        name: "NotFound",
        $metadata: { httpStatusCode: 404 },
      })
    );
    expect(await r2.bucketExists()).toBe(false);
  });

  it("returns false on a bare 404 with no error name", async () => {
    send.mockRejectedValue(
      Object.assign(new Error("nope"), { $metadata: { httpStatusCode: 404 } })
    );
    expect(await r2.bucketExists()).toBe(false);
  });

  it("rethrows a genuine failure rather than reading it as a missing bucket", async () => {
    // A bad credential or a connectivity failure must not masquerade as
    // "bucket missing" -- the backfill's preflight message depends on being
    // able to tell those apart.
    send.mockRejectedValue(
      Object.assign(new Error("boom"), { $metadata: { httpStatusCode: 500 } })
    );
    await expect(r2.bucketExists()).rejects.toThrow("boom");
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

  it("throws when the batch delete reports per-object failures", async () => {
    // The S3 batch delete API signals per-object failures in the response body
    // with a 200, not as a thrown error. A discarded response would let a
    // partial delete read as a clean sweep and leave stale files behind.
    send
      .mockResolvedValueOnce({
        Contents: [{ Key: "scorm/c1/a.html" }, { Key: "scorm/c1/b.js" }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({
        Errors: [
          { Key: "scorm/c1/a.html", Code: "AccessDenied", Message: "Access Denied" },
        ],
      });

    await expect(r2.deletePrefix("scorm/c1/")).rejects.toThrow(/scorm\/c1\/a\.html/);
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
