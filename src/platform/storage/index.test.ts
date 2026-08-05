import { describe, expect, it, vi, beforeEach } from "vitest";

const { r2, blob, disk } = vi.hoisted(() => ({
  r2: { putObject: vi.fn(), getObject: vi.fn(), deleteObject: vi.fn(), deletePrefix: vi.fn() },
  blob: { putObject: vi.fn(), getObject: vi.fn(), deleteObject: vi.fn(), deletePrefix: vi.fn() },
  disk: { putObject: vi.fn(), getObject: vi.fn(), deleteObject: vi.fn(), deletePrefix: vi.fn() },
}));

vi.mock("./r2", () => r2);
vi.mock("./blob", () => blob);
vi.mock("./disk", () => disk);

const configMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/platform/config", () => ({ get config() { return configMock.value; } }));

async function loadStorage(env: Record<string, unknown>) {
  configMock.value = { UPLOAD_DIR: "/tmp/x", ...env };
  vi.resetModules();
  return import("./index");
}

beforeEach(() => {
  for (const d of [r2, blob, disk]) {
    for (const fn of Object.values(d)) fn.mockReset();
  }
});

const R2_ONLY = { R2_BUCKET: "b", R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s" };
const BLOB_ONLY = { BLOB_READ_WRITE_TOKEN: "t" };
const BOTH = { ...R2_ONLY, ...BLOB_ONLY };

describe("driver selection", () => {
  it("uses R2 when the R2 config is present", async () => {
    const s = await loadStorage(R2_ONLY);
    r2.getObject.mockResolvedValue(Buffer.from("r2"));
    expect(await s.getObject("k")).toEqual(Buffer.from("r2"));
    expect(disk.getObject).not.toHaveBeenCalled();
    expect(blob.getObject).not.toHaveBeenCalled();
  });

  it("uses Vercel Blob when only the Blob token is present (the rolled-back state)", async () => {
    // This is the rollback path. Before this task, unsetting the R2 variables
    // selected the DISK driver, which on Vercel is ephemeral -- the documented
    // rollback was a storage outage.
    const s = await loadStorage(BLOB_ONLY);
    blob.getObject.mockResolvedValue(Buffer.from("blob"));
    expect(await s.getObject("k")).toEqual(Buffer.from("blob"));
    expect(disk.getObject).not.toHaveBeenCalled();
    expect(r2.getObject).not.toHaveBeenCalled();
  });

  it("uses local disk when neither is configured", async () => {
    const s = await loadStorage({});
    disk.getObject.mockResolvedValue(Buffer.from("disk"));
    expect(await s.getObject("k")).toEqual(Buffer.from("disk"));
    expect(r2.getObject).not.toHaveBeenCalled();
    expect(blob.getObject).not.toHaveBeenCalled();
  });

  it("reports usingRemoteStorage for R2 and for Blob, but not for disk", async () => {
    expect((await loadStorage(R2_ONLY)).usingRemoteStorage).toBe(true);
    expect((await loadStorage(BLOB_ONLY)).usingRemoteStorage).toBe(true);
    expect((await loadStorage({})).usingRemoteStorage).toBe(false);
  });

  it("reports supportsPresignedUpload only for R2, not for Blob-only or disk", async () => {
    expect((await loadStorage(R2_ONLY)).supportsPresignedUpload).toBe(true);
    // This is the regression the fix exists to prevent: usingRemoteStorage is
    // true in the Blob-only rolled-back state, but presigning is an R2-only
    // capability, so this flag must stay false there.
    expect((await loadStorage(BLOB_ONLY)).supportsPresignedUpload).toBe(false);
    expect((await loadStorage({})).supportsPresignedUpload).toBe(false);
  });
});

describe("cutover-window fallback", () => {
  it("reads through to Blob when R2 misses and both are configured", async () => {
    const s = await loadStorage(BOTH);
    r2.getObject.mockResolvedValue(null);
    blob.getObject.mockResolvedValue(Buffer.from("legacy"));
    expect(await s.getObject("k")).toEqual(Buffer.from("legacy"));
  });

  it("does not touch Blob when R2 hits", async () => {
    const s = await loadStorage(BOTH);
    r2.getObject.mockResolvedValue(Buffer.from("fresh"));
    expect(await s.getObject("k")).toEqual(Buffer.from("fresh"));
    expect(blob.getObject).not.toHaveBeenCalled();
  });

  it("returns null when both miss", async () => {
    const s = await loadStorage(BOTH);
    r2.getObject.mockResolvedValue(null);
    blob.getObject.mockResolvedValue(null);
    expect(await s.getObject("k")).toBeNull();
  });

  it("does not read through when no Blob token is configured", async () => {
    const s = await loadStorage(R2_ONLY);
    r2.getObject.mockResolvedValue(null);
    expect(await s.getObject("k")).toBeNull();
    expect(blob.getObject).not.toHaveBeenCalled();
  });

  it("writes only to R2, never duplicating into Blob", async () => {
    const s = await loadStorage(BOTH);
    await s.putObject("k", Buffer.from("x"), "text/plain");
    expect(r2.putObject).toHaveBeenCalledTimes(1);
    expect(blob.putObject).not.toHaveBeenCalled();
  });

  it("deletes from BOTH stores so a Blob-only copy cannot resurrect", async () => {
    // Deleting only from R2 would be a no-op for an object that lives solely in
    // Blob, and the next read would fall back and serve the supposedly deleted
    // file. This is the one place the fallback could reintroduce data.
    const s = await loadStorage(BOTH);
    await s.deleteObject("k");
    expect(r2.deleteObject).toHaveBeenCalledWith("k");
    expect(blob.deleteObject).toHaveBeenCalledWith("k");
  });

  it("deletes a prefix from BOTH stores for the same reason", async () => {
    const s = await loadStorage(BOTH);
    await s.deletePrefix("scorm/c1/");
    expect(r2.deletePrefix).toHaveBeenCalledWith("scorm/c1/");
    expect(blob.deletePrefix).toHaveBeenCalledWith("scorm/c1/");
  });
});

describe("prefix validation", () => {
  it("rejects an unsafe prefix before reaching any driver", async () => {
    const s = await loadStorage(BOTH);
    await expect(s.deletePrefix("../etc")).rejects.toThrow(/unsafe storage prefix/);
    expect(r2.deletePrefix).not.toHaveBeenCalled();
    expect(blob.deletePrefix).not.toHaveBeenCalled();
    expect(disk.deletePrefix).not.toHaveBeenCalled();
  });
});
