import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { setSetting } from "@/platform/settings/service";
import { requestMemberLoginLink } from "./member-magic-link";

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

async function seedActive(contactEmail: string, name = "Casey Rivera") {
  return prisma.person.create({ data: { name, contactEmail, status: "ACTIVE" } });
}

it("emails an active non-Yale member a /login/verify link addressed to their contactEmail", async () => {
  const person = await seedActive("casey@example.org", "Casey Rivera");
  const result = await requestMemberLoginLink("Casey@Example.org");
  expect(result).toBe("sent");

  const emails = await prisma.emailLog.findMany();
  expect(emails).toHaveLength(1);
  expect(emails[0].toEmail).toBe("casey@example.org");
  expect(emails[0].template).toBe("auth.member_login_link");
  expect(emails[0].personId).toBe(person.id);
  expect(emails[0].html).toContain("/login/verify?token=");
  expect(emails[0].html).toContain("Casey"); // greeted by first name from Person.name
});

it("is a silent no-op for an unknown email (no enumeration)", async () => {
  const result = await requestMemberLoginLink("nobody@example.org");
  expect(result).toBe("sent");
  expect(await prisma.emailLog.count()).toBe(0);
  expect(await prisma.memberLoginToken.count()).toBe(0);
});

it("is a silent no-op for an offboarded member", async () => {
  await prisma.person.create({ data: { name: "Gone", contactEmail: "gone@example.org", status: "OFFBOARDED" } });
  expect(await requestMemberLoginLink("gone@example.org")).toBe("sent");
  expect(await prisma.emailLog.count()).toBe(0);
});

it("refuses a Yale address with use-yale and sends nothing", async () => {
  await seedActive("reed@yale.edu");
  expect(await requestMemberLoginLink("reed@yale.edu")).toBe("use-yale");
  expect(await prisma.emailLog.count()).toBe(0);
  expect(await prisma.memberLoginToken.count()).toBe(0);
});

it("rate-limits to 3 links per 15 minutes per email", async () => {
  await seedActive("casey@example.org");
  await requestMemberLoginLink("casey@example.org");
  await requestMemberLoginLink("casey@example.org");
  await requestMemberLoginLink("casey@example.org");
  await requestMemberLoginLink("casey@example.org");
  expect(await prisma.emailLog.count()).toBeLessThanOrEqual(3);
});

it("returns disabled and sends nothing when the kill-switch is off", async () => {
  await seedActive("casey@example.org");
  await setSetting("auth.memberMagicLinkEnabled", false, null);
  expect(await requestMemberLoginLink("casey@example.org")).toBe("disabled");
  expect(await prisma.emailLog.count()).toBe(0);
});

it("builds the link from the configurable app.baseUrl setting", async () => {
  await seedActive("casey@example.org");
  await setSetting("app.baseUrl", "https://hub.havenfreeclinic.org", null);
  await requestMemberLoginLink("casey@example.org");
  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "auth.member_login_link" } });
  expect(mail.html).toContain("https://hub.havenfreeclinic.org/login/verify?token=");
  expect(mail.html).not.toContain("http://localhost:3000/login/verify");
});
