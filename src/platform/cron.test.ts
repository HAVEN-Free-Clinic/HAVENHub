// src/platform/cron.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { authorizeCron } from "./cron";

const SECRET = "s3cr3t-high-entropy-value";

function reqWith(authHeader?: string): Request {
  return new Request("https://hub/api/cron/email", {
    headers: authHeader === undefined ? {} : { authorization: authHeader },
  });
}

describe("authorizeCron", () => {
  const original = process.env.CRON_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it("fails closed when CRON_SECRET is unset", () => {
    delete process.env.CRON_SECRET;
    expect(authorizeCron(reqWith(`Bearer ${SECRET}`))).toBe(false);
  });

  it("fails closed when CRON_SECRET is empty", () => {
    process.env.CRON_SECRET = "";
    expect(authorizeCron(reqWith("Bearer "))).toBe(false);
  });

  it("authorizes a request carrying the exact bearer token", () => {
    process.env.CRON_SECRET = SECRET;
    expect(authorizeCron(reqWith(`Bearer ${SECRET}`))).toBe(true);
  });

  it("rejects a wrong secret of the same length", () => {
    process.env.CRON_SECRET = SECRET;
    const wrong = "x".repeat(SECRET.length);
    expect(authorizeCron(reqWith(`Bearer ${wrong}`))).toBe(false);
  });

  it("rejects a token of a different length without throwing", () => {
    // timingSafeEqual requires equal-length buffers; the length guard must
    // short-circuit so a mismatched length returns false, never throws.
    process.env.CRON_SECRET = SECRET;
    expect(() => authorizeCron(reqWith("Bearer short"))).not.toThrow();
    expect(authorizeCron(reqWith("Bearer short"))).toBe(false);
    expect(authorizeCron(reqWith(`Bearer ${SECRET}-extra`))).toBe(false);
  });

  it("rejects a missing Authorization header", () => {
    process.env.CRON_SECRET = SECRET;
    expect(authorizeCron(reqWith(undefined))).toBe(false);
  });

  it("rejects a header without the Bearer scheme", () => {
    process.env.CRON_SECRET = SECRET;
    expect(authorizeCron(reqWith(SECRET))).toBe(false);
  });
});
