import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createAuthorization, exchangeAuthorizationCode } from "@/platform/oauth/tokens";
import { GET as me } from "./me/route";
import { GET as schedule } from "./schedule/route";
import { GET as notifications } from "./notifications/route";
import { POST as markRead } from "./notifications/read/route";

const CLIENT = "haven-mobile-test";
const REDIRECT = "org.havenfreeclinic.hub:/oauth";
const VERIFIER = "m".repeat(60);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const HOST = "hub.havenfreeclinic.org";

beforeEach(async () => {
  await resetDb();
});

async function personWithToken(opts: { permissions?: string[]; resource?: string } = {}) {
  const person = await prisma.person.create({ data: { name: "Mobile User", legalFirstName: "Mobile", lastName: "User", netId: "mu1" } });
  if (opts.permissions?.length) {
    const role = await prisma.role.create({
      data: { name: "Mobile test role", grants: { create: opts.permissions.map((permission) => ({ permission })) } },
    });
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: person.id, termId: null } });
  }
  const { code } = await createAuthorization({
    personId: person.id,
    clientId: CLIENT,
    resource: opts.resource ?? `https://${HOST}/api/mobile`,
    scope: "mobile",
    redirectUri: REDIRECT,
    codeChallenge: CHALLENGE,
  });
  const t = await exchangeAuthorizationCode({ code, clientId: CLIENT, redirectUri: REDIRECT, codeVerifier: VERIFIER });
  if (!("access_token" in t)) throw new Error("exchange failed");
  return { person, token: t.access_token };
}

function req(path: string, token?: string, init: RequestInit = {}) {
  return new Request(`https://${HOST}/api/mobile/v1${path}`, {
    ...init,
    headers: { host: HOST, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
}

describe("/api/mobile/v1", () => {
  it("answers a tokenless request with a 401 that points at the mobile resource", async () => {
    const res = await me(req("/me"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `resource_metadata="https://${HOST}/.well-known/oauth-protected-resource/api/mobile"`,
    );
  });

  it("refuses a token consented for a different resource", async () => {
    const { token } = await personWithToken({ resource: `https://${HOST}/api/mcp/recruitment` });
    expect((await me(req("/me", token))).status).toBe(401);
  });

  it("stops an offboarded person's live token immediately", async () => {
    const { person, token } = await personWithToken();
    await prisma.person.update({ where: { id: person.id }, data: { status: "OFFBOARDED" } });
    expect((await me(req("/me", token))).status).toBe(401);
  });

  it("returns the signed-in person and only the modules the Hub would show them", async () => {
    const { person, token } = await personWithToken({ permissions: ["schedule.view"] });
    const res = await me(req("/me", token));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.person).toEqual({ id: person.id, name: "Mobile User", email: "mu1@yale.edu" });
    const ids = body.modules.map((m: { id: string }) => m.id);
    expect(ids).toContain("schedule");
    expect(ids).not.toContain("admin");
    expect(body.modules.find((m: { id: string }) => m.id === "schedule").url).toBe(`https://${HOST}/schedule`);
  });

  it("applies the schedule module's own gate", async () => {
    const without = await personWithToken();
    expect((await schedule(req("/schedule", without.token))).status).toBe(403);
    await resetDb();
    const withAccess = await personWithToken({ permissions: ["schedule.view"] });
    const res = await schedule(req("/schedule", withAccess.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ scheduleUrl: `https://${HOST}/schedule`, terms: [] });
  });

  it("lists notifications with absolute links, and marks only the caller's own read", async () => {
    const { person, token } = await personWithToken();
    const other = await prisma.person.create({ data: { name: "Someone Else" } });
    const mine = await prisma.notification.create({
      data: { personId: person.id, type: "test", title: "Hello", body: "Body", link: "/my-info" },
    });
    await prisma.notification.create({ data: { personId: person.id, type: "test", title: "Second", body: "" } });
    const theirs = await prisma.notification.create({ data: { personId: other.id, type: "test", title: "Not yours", body: "" } });

    const list = await (await notifications(req("/notifications", token))).json();
    expect(list.unreadCount).toBe(2);
    expect(list.hasMore).toBe(false);
    expect(list.notifications.map((n: { title: string }) => n.title).sort()).toEqual(["Hello", "Second"]);
    expect(list.notifications.find((n: { id: string }) => n.id === mine.id).url).toBe(`https://${HOST}/my-info`);

    const post = (body: unknown) => markRead(req("/notifications/read", token, { method: "POST", body: JSON.stringify(body) }));
    expect(await (await post({ id: mine.id })).json()).toEqual({ unreadCount: 1 });
    await post({ id: theirs.id });
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: theirs.id } })).readAt).toBeNull();
    expect(await (await post({ all: true })).json()).toEqual({ unreadCount: 0 });
    expect((await post({ nope: 1 })).status).toBe(400);
  });
});
