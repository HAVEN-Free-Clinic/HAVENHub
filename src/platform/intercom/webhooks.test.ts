import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { verifyIntercomWebhookSignature } from "./webhooks";

const SECRET = "client-secret-high-entropy";

function sign(body: string, secret: string): string {
  return `sha1=${createHmac("sha1", secret).update(body, "utf8").digest("hex")}`;
}

describe("verifyIntercomWebhookSignature", () => {
  it("accepts a correctly-signed body", () => {
    const body = JSON.stringify({ topic: "ticket.created" });
    expect(verifyIntercomWebhookSignature(body, sign(body, SECRET), SECRET)).toBe(true);
  });

  it("rejects a missing signature header", () => {
    const body = JSON.stringify({ topic: "ticket.created" });
    expect(verifyIntercomWebhookSignature(body, null, SECRET)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const body = JSON.stringify({ topic: "ticket.created" });
    expect(verifyIntercomWebhookSignature(body, sign(body, "wrong-secret"), SECRET)).toBe(false);
  });

  it("rejects a signature computed over a different body (a tampered payload)", () => {
    const signedBody = JSON.stringify({ topic: "ticket.created" });
    const tamperedBody = JSON.stringify({ topic: "ticket.state.updated" });
    expect(verifyIntercomWebhookSignature(tamperedBody, sign(signedBody, SECRET), SECRET)).toBe(false);
  });

  it("rejects a malformed signature header without throwing", () => {
    const body = JSON.stringify({ topic: "ticket.created" });
    expect(() => verifyIntercomWebhookSignature(body, "not-a-real-signature", SECRET)).not.toThrow();
    expect(verifyIntercomWebhookSignature(body, "not-a-real-signature", SECRET)).toBe(false);
  });

  it("rejects a signature missing the sha1= prefix even if the hex digest matches", () => {
    const body = JSON.stringify({ topic: "ticket.created" });
    const bareDigest = sign(body, SECRET).replace("sha1=", "");
    expect(verifyIntercomWebhookSignature(body, bareDigest, SECRET)).toBe(false);
  });
});
