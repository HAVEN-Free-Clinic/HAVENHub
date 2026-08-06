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
