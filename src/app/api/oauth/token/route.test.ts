import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createAuthorization } from "@/platform/oauth/tokens";
import { POST } from "./route";

const CLIENT = "https://claude.ai/oauth/claude-code-client-metadata";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "q".repeat(50);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

beforeEach(resetDb);

function form(fields: Record<string, string>) {
  return new Request("https://hub.test/api/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

async function code() {
  const person = await prisma.person.create({ data: { name: "Token Tester" } });
  return (
    await createAuthorization({
      personId: person.id,
      clientId: CLIENT,
      resource: "https://hub.test/api/mcp/recruitment",
      scope: "recruitment:read",
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
    })
  ).code;
}

describe("POST /api/oauth/token", () => {
  it("exchanges a code for tokens from a form-encoded body, uncacheably", async () => {
    const res = await POST(
      form({ grant_type: "authorization_code", code: await code(), client_id: CLIENT, redirect_uri: REDIRECT, code_verifier: VERIFIER }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "recruitment:read" });

    const refreshed = await POST(form({ grant_type: "refresh_token", refresh_token: body.refresh_token, client_id: CLIENT }));
    expect(refreshed.status).toBe(200);
  });

  it("answers a bad code with invalid_grant, the code Claude acts on", async () => {
    const res = await POST(
      form({ grant_type: "authorization_code", code: "nope", client_id: CLIENT, redirect_uri: REDIRECT, code_verifier: VERIFIER }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses an unknown registered client as invalid_client", async () => {
    const res = await POST(form({ grant_type: "refresh_token", refresh_token: "x", client_id: "hub_unknown" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_client" });
  });

  it("refuses other grant types, including client_credentials", async () => {
    const res = await POST(form({ grant_type: "client_credentials", client_id: CLIENT }));
    expect(await res.json()).toMatchObject({ error: "unsupported_grant_type" });
  });

  it("requires the PKCE verifier", async () => {
    const res = await POST(form({ grant_type: "authorization_code", code: await code(), client_id: CLIENT, redirect_uri: REDIRECT }));
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });
});
