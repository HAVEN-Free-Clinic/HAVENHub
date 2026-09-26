import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { POST } from "./route";

beforeEach(resetDb);

function post(body: string, ip = "192.0.2.10") {
  return POST(new Request("https://hub.test/api/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body,
  }));
}

describe("POST /api/oauth/register", () => {
  it("returns 201 with the issued client_id", async () => {
    const res = await post(JSON.stringify({ client_name: "MCP Inspector", redirect_uris: ["http://localhost:6274/oauth/callback"], token_endpoint_auth_method: "none" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ client_name: "MCP Inspector", token_endpoint_auth_method: "none" });
  });

  it("returns 400 with an RFC 7591 error for bad metadata or a non-JSON body", async () => {
    expect(await (await post(JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }))).json()).toMatchObject({ error: "invalid_redirect_uri" });
    expect((await post("not json")).status).toBe(400);
  });
});
