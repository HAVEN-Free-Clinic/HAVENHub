import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";

// The server action module imports next/headers + auth at top level; mock them
// so it imports cleanly in the node test env (the cookie/signOut paths are
// exercised elsewhere — here we only drive requestMagicLinkAction).
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() })) }));
vi.mock("@/platform/auth/auth", () => ({ signOut: vi.fn(async () => {}), auth: vi.fn(async () => null) }));

import { requestMagicLinkAction } from "./portal-actions";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { vi.clearAllMocks(); await resetDb(); });

it("forwards a deep-link next from the sign-in form into the magic-link email", async () => {
  const fd = new FormData();
  fd.set("email", "reed@yale.edu");
  fd.set("next", "/apply/spring-2026");

  const res = await requestMagicLinkAction(fd);
  expect(res.ok).toBe(true);

  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.portal_link" } });
  expect(mail.html).toContain(`next=${encodeURIComponent("/apply/spring-2026")}`);
});

it("sends a clean link when the form carries no next", async () => {
  const fd = new FormData();
  fd.set("email", "reed@yale.edu");

  const res = await requestMagicLinkAction(fd);
  expect(res.ok).toBe(true);

  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.portal_link" } });
  expect(mail.html).not.toContain("next=");
});
