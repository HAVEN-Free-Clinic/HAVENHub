import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { isUniqueConstraintError } from "./db";

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
