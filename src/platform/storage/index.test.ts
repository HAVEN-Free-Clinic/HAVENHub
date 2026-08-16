import { describe, expect, it, vi, beforeEach } from "vitest";

const { r2, disk } = vi.hoisted(() => ({
  r2: { putObject: vi.fn(), getObject: vi.fn(), deleteObject: vi.fn(), deletePrefix: vi.fn() },
  disk: { putObject: vi.fn(), getObject: vi.fn(), deleteObject: vi.fn(), deletePrefix: vi.fn() },
}));

vi.mock("./r2", () => r2);
vi.mock("./disk", () => disk);

const configMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/platform/config", () => ({ get config() { return configMock.value; } }));

async function loadStorage(env: Record<string, unknown>) {
  configMock.value = { UPLOAD_DIR: "/tmp/x", ...env };
  vi.resetModules();
  return import("./index");
}

beforeEach(() => {
  for (const d of [r2, disk]) {
    for (const fn of Object.values(d)) fn.mockReset();
  }
});

const R2_ONLY = { R2_BUCKET: "b", R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s" };

describe("driver selection", () => {
  it("uses R2 when the R2 config is present", async () => {
    const s = await loadStorage(R2_ONLY);
    r2.getObject.mockResolvedValue(Buffer.from("r2"));
    expect(await s.getObject("k")).toEqual(Buffer.from("r2"));
    expect(disk.getObject).not.toHaveBeenCalled();
  });

  it("uses local disk when R2 is not configured", async () => {
    const s = await loadStorage({});
    disk.getObject.mockResolvedValue(Buffer.from("disk"));
    expect(await s.getObject("k")).toEqual(Buffer.from("disk"));
    expect(r2.getObject).not.toHaveBeenCalled();
  });

  it("reports usingRemoteStorage true for R2, false for disk", async () => {
    expect((await loadStorage(R2_ONLY)).usingRemoteStorage).toBe(true);
    expect((await loadStorage({})).usingRemoteStorage).toBe(false);
  });

  it("reports supportsPresignedUpload true for R2, false for disk", async () => {
    expect((await loadStorage(R2_ONLY)).supportsPresignedUpload).toBe(true);
    expect((await loadStorage({})).supportsPresignedUpload).toBe(false);
  });
});

describe("prefix validation", () => {
  it("rejects an unsafe prefix before reaching any driver", async () => {
    const s = await loadStorage(R2_ONLY);
    await expect(s.deletePrefix("../etc")).rejects.toThrow(/unsafe storage prefix/);
    expect(r2.deletePrefix).not.toHaveBeenCalled();
    expect(disk.deletePrefix).not.toHaveBeenCalled();
  });
});
