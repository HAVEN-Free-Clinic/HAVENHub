import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { isUniqueConstraintError, isSchemaMissingError } from "./db";

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
