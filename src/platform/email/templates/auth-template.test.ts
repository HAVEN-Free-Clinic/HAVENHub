import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { getDescriptor } from "@/platform/email/templates/registry";

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

it("registers auth.member_login_link with firstName + loginUrl and renders both", async () => {
  const descriptor = getDescriptor("auth.member_login_link");
  expect(descriptor).toBeDefined();
  expect(descriptor?.variables.map((v) => v.name).sort()).toEqual(["firstName", "loginUrl"]);

  const mail = await renderEmail("auth.member_login_link", {
    firstName: "Sam",
    loginUrl: "https://hub.example.org/login/verify?token=abc",
  });
  expect(mail.subject).toContain("sign-in link");
  expect(mail.html).toContain("Sam");
  expect(mail.html).toContain('href="https://hub.example.org/login/verify?token=abc"');
});
