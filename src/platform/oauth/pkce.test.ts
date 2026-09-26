import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isValidChallenge, verifyPkceS256 } from "./pkce";

const verifier = "a".repeat(20) + "B-._~" + "9".repeat(25);
const challenge = createHash("sha256").update(verifier).digest("base64url");

describe("PKCE S256", () => {
  it("accepts the verifier its challenge was made from", () => {
    expect(isValidChallenge(challenge)).toBe(true);
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it("refuses any other verifier", () => {
    expect(verifyPkceS256(verifier + "x", challenge)).toBe(false);
  });

  it("refuses the 'plain' method's trick of presenting the challenge as the verifier", () => {
    expect(verifyPkceS256(challenge, challenge)).toBe(false);
  });

  it("refuses a verifier outside RFC 7636's length or alphabet", () => {
    expect(verifyPkceS256("short", challenge)).toBe(false);
    expect(verifyPkceS256("x".repeat(129), challenge)).toBe(false);
    expect(verifyPkceS256("a".repeat(42) + "!", challenge)).toBe(false);
  });
});
