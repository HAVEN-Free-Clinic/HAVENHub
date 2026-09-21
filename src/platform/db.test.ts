import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { isDbUnreachableError, isSchemaMissingError, isSerializationError, isUniqueConstraintError, prisma, runSerializable, withDbRetry } from "./db";

describe("isUniqueConstraintError", () => {
  it("is true for a P2002 known-request error", () => {
    const err = new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });
    expect(isUniqueConstraintError(err)).toBe(true);
  });
  it("is false for another Prisma code and for a plain error", () => {
    const other = new Prisma.PrismaClientKnownRequestError("nf", { code: "P2025", clientVersion: "x" });
    expect(isUniqueConstraintError(other)).toBe(false);
    expect(isUniqueConstraintError(new Error("nope"))).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
  });
});

describe("isSerializationError", () => {
  it("is true for a P2034 write-conflict and false otherwise", () => {
    const conflict = new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "x" });
    expect(isSerializationError(conflict)).toBe(true);
    const other = new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });
    expect(isSerializationError(other)).toBe(false);
    expect(isSerializationError(new Error("nope"))).toBe(false);
  });
});

describe("runSerializable", () => {
  afterEach(() => vi.restoreAllMocks());

  const conflict = () =>
    new Prisma.PrismaClientKnownRequestError("write conflict", { code: "P2034", clientVersion: "x" });
  // backoffMs: 0 throughout so the suite does not sleep. The one wait case sets
  // it and pins Math.random to make the delay deterministic.
  const noWait = { backoffMs: 0 };

  it("runs the callback once and returns its value when there is no conflict", async () => {
    const tx = vi.spyOn(prisma, "$transaction").mockResolvedValue("ok" as never);
    await expect(runSerializable(async () => "ok", noWait)).resolves.toBe("ok");
    expect(tx).toHaveBeenCalledTimes(1);
  });

  it("retries a write-conflict and resolves once it clears", async () => {
    const tx = vi
      .spyOn(prisma, "$transaction")
      .mockRejectedValueOnce(conflict())
      .mockResolvedValue("ok" as never);
    await expect(runSerializable(async () => "ok", noWait)).resolves.toBe("ok");
    expect(tx).toHaveBeenCalledTimes(2);
  });

  it("gives up after the budget and rethrows the conflict", async () => {
    const tx = vi.spyOn(prisma, "$transaction").mockRejectedValue(conflict());
    await expect(runSerializable(async () => "ok", { attempts: 3, backoffMs: 0 })).rejects.toThrow("write conflict");
    expect(tx).toHaveBeenCalledTimes(3);
  });

  it("does not retry an error that is not a write-conflict", async () => {
    const tx = vi.spyOn(prisma, "$transaction").mockRejectedValue(new Error("boom"));
    await expect(runSerializable(async () => "ok", noWait)).rejects.toThrow("boom");
    expect(tx).toHaveBeenCalledTimes(1);
  });

  it("waits a jittered interval between attempts, never before the first", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(conflict()).mockResolvedValue("ok" as never);
    const started = Date.now();
    // One failure => one wait of 0.5 * 40 * 1 = 20ms. Asserted as a floor so a
    // slow runner cannot flake.
    await expect(runSerializable(async () => "ok", { backoffMs: 40 })).resolves.toBe("ok");
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});

describe("isSchemaMissingError", () => {
  it("is true for a missing table (P2021) and a missing column (P2022)", () => {
    const table = new Prisma.PrismaClientKnownRequestError("no table", { code: "P2021", clientVersion: "x" });
    const column = new Prisma.PrismaClientKnownRequestError("no column", { code: "P2022", clientVersion: "x" });
    expect(isSchemaMissingError(table)).toBe(true);
    expect(isSchemaMissingError(column)).toBe(true);
  });
  it("is false for a connectivity code and for a plain error", () => {
    const unreachable = new Prisma.PrismaClientKnownRequestError("down", { code: "P1001", clientVersion: "x" });
    expect(isSchemaMissingError(unreachable)).toBe(false);
    expect(isSchemaMissingError(new Error("nope"))).toBe(false);
    expect(isSchemaMissingError(null)).toBe(false);
  });
});

/** A PgBouncer-pooled connection closed mid-query: the fault seen in production. */
const poolerClosed = () =>
  new Prisma.PrismaClientKnownRequestError("Server has closed the connection", {
    code: "P1017",
    clientVersion: "x",
  });

describe("withDbRetry", () => {
  // delayMs: 0 throughout -- the backoff is covered by its own case below, and
  // paying it in every other case would make the suite sleep for no reason.
  const noWait = { delayMs: 0 };

  it("returns the value without retrying when the call succeeds", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withDbRetry(fn, noWait)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a dropped connection and resolves", async () => {
    const fn = vi.fn().mockRejectedValueOnce(poolerClosed()).mockResolvedValue("ok");
    await expect(withDbRetry(fn, noWait)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries every code isDbUnreachableError accepts", async () => {
    const transient = [
      new Prisma.PrismaClientKnownRequestError("a", { code: "P1001", clientVersion: "x" }),
      new Prisma.PrismaClientKnownRequestError("b", { code: "P1002", clientVersion: "x" }),
      new Prisma.PrismaClientKnownRequestError("c", { code: "P1008", clientVersion: "x" }),
      new Prisma.PrismaClientKnownRequestError("d", { code: "P1017", clientVersion: "x" }),
      new Prisma.PrismaClientInitializationError("e", "x"),
    ];
    for (const err of transient) {
      expect(isDbUnreachableError(err)).toBe(true);
      const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");
      await expect(withDbRetry(fn, noWait)).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  it("gives up after the budget and rethrows the database error", async () => {
    const fn = vi.fn().mockRejectedValue(poolerClosed());
    await expect(withDbRetry(fn, noWait)).rejects.toThrow("Server has closed the connection");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("never converts a spent budget into a null answer", async () => {
    // The invariant getActivePerson depends on: a caller reading null as "sign
    // this member out" must not see null because the database was unreachable.
    await expect(withDbRetry(async () => { throw poolerClosed(); }, noWait)).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
  });

  it("does not retry an error that is not a connectivity fault", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(withDbRetry(fn, noWait)).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry a unique-constraint violation", async () => {
    const dup = new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });
    const fn = vi.fn().mockRejectedValue(dup);
    await expect(withDbRetry(fn, noWait)).rejects.toThrow("dup");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("honours a custom attempt budget", async () => {
    const fn = vi.fn().mockRejectedValue(poolerClosed());
    await expect(withDbRetry(fn, { attempts: 2, delayMs: 0 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("waits between attempts, and not before the first", async () => {
    const fn = vi.fn().mockRejectedValueOnce(poolerClosed()).mockResolvedValue("ok");
    const started = Date.now();
    await expect(withDbRetry(fn, { delayMs: 20 })).resolves.toBe("ok");
    // One failure => one 20ms wait. Asserted as a floor, not a window, so a slow
    // CI runner cannot make this flake.
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});
