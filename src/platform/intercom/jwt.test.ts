import { describe, it, expect, afterEach, vi } from "vitest";
import { jwtVerify, decodeProtectedHeader } from "jose";
import { mintIntercomUserJwt, INTERCOM_TOKEN_TTL_SECONDS } from "./jwt";

const SECRET = "test-messenger-secret";
const key = new TextEncoder().encode(SECRET);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mintIntercomUserJwt", () => {
  it("signs with HS256 and keys the contact on the Person id", async () => {
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", SECRET);

    const token = await mintIntercomUserJwt({
      personId: "person_abc",
      name: "Sam Rivera",
      email: "sam@example.com",
      audience: {},
    });

    expect(decodeProtectedHeader(token).alg).toBe("HS256");
    const { payload } = await jwtVerify(token, key);
    expect(payload.user_id).toBe("person_abc");
    expect(payload.email).toBe("sam@example.com");
    expect(payload.name).toBe("Sam Rivera");
  });

  it("expires after the configured TTL", async () => {
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", SECRET);

    const token = await mintIntercomUserJwt({ personId: "p1", name: null, email: null, audience: {} });

    const { payload } = await jwtVerify(token, key);
    expect(payload.exp! - payload.iat!).toBe(INTERCOM_TOKEN_TTL_SECONDS);
  });

  it("omits optional claims rather than sending null, which would clear them", async () => {
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", SECRET);

    const token = await mintIntercomUserJwt({ personId: "p1", name: null, email: null, audience: {} });

    const { payload } = await jwtVerify(token, key);
    expect("email" in payload).toBe(false);
    expect("name" in payload).toBe(false);
  });

  it("carries audience flags into the signed payload, false values included", async () => {
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", SECRET);

    const token = await mintIntercomUserJwt({
      personId: "p1",
      name: null,
      email: null,
      audience: { "Hub admin access": true, "Hub recruitment access": false },
    });

    const { payload } = await jwtVerify(token, key);
    expect(payload["Hub admin access"]).toBe(true);
    // Present-and-false, not absent: Intercom merges attributes, so an omitted
    // key would leave a previously-granted permission in place on the contact.
    expect(payload["Hub recruitment access"]).toBe(false);
  });

  it("cannot be verified with a different secret", async () => {
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", SECRET);

    const token = await mintIntercomUserJwt({ personId: "p1", name: null, email: null, audience: {} });

    await expect(jwtVerify(token, new TextEncoder().encode("wrong-secret"))).rejects.toThrow();
  });

  it("throws rather than minting an unsigned token when the secret is unset", async () => {
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "");

    await expect(
      mintIntercomUserJwt({ personId: "p1", name: null, email: null, audience: {} })
    ).rejects.toThrow("INTERCOM_MESSENGER_SECRET is not set");
  });
});
