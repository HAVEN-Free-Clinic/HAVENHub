import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const e = Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${url}` });
    throw e;
  },
}));
vi.mock("@/platform/auth/session", () => ({
  requirePermission: vi.fn(),
}));

import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { requirePermission } from "@/platform/auth/session";
import { createCycle } from "@/modules/recruitment/services/cycles";
import { createCycleAction } from "./actions";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function actor() {
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  vi.mocked(requirePermission).mockResolvedValue({ personId: lead.id } as never);
  return { lead, term };
}

it("redirects to a friendly error when the public slug is already taken (audit3 L2)", async () => {
  const { lead, term } = await actor();
  // A cycle already owns this public slug; a colliding create throws P2002.
  await createCycle({ track: "VOLUNTEER", termId: term.id, title: "First", publicSlug: "taken", departments: ["SRHD"], acceptsRenewals: false, createdById: lead.id });

  const err = await createCycleAction(
    form({ title: "Taken", track: "VOLUNTEER", termId: term.id, departments: "SRHD", publicSlug: "taken" }),
  ).catch((e) => e);
  // The unique-constraint collision lands on the friendly reserved-word flow,
  // not the generic error page.
  expect(err.digest).toContain("/recruitment/cycles/new?error=");
  expect(err.digest).toContain("already");
  // No second cycle was created.
  expect(await prisma.recruitmentCycle.count({ where: { publicSlug: "taken" } })).toBe(1);
});

it("redirects to the builder on a successful create with a fresh slug", async () => {
  const { term } = await actor();
  const err = await createCycleAction(
    form({ title: "Fresh", track: "VOLUNTEER", termId: term.id, departments: "SRHD", publicSlug: "fresh-one" }),
  ).catch((e) => e);
  const cycle = await prisma.recruitmentCycle.findFirstOrThrow({ where: { publicSlug: "fresh-one" } });
  expect(err.digest).toBe(`NEXT_REDIRECT;/recruitment/cycles/${cycle.id}/builder`);
});

it("stores every department the multi-select submits (getAll, not comma-split)", async () => {
  const { term } = await actor();
  // The department multi-select posts one "departments" value per chosen chip,
  // so the action must read them all back with getAll -- a stale comma-split
  // would collapse them into a single bogus "SRHD, MDIC" code.
  const fd = new FormData();
  fd.set("title", "Multi");
  fd.set("track", "VOLUNTEER");
  fd.set("termId", term.id);
  fd.set("publicSlug", "multi-dept");
  fd.append("departments", "SRHD");
  fd.append("departments", "MDIC");
  await createCycleAction(fd).catch((e) => e); // redirects on success
  const cycle = await prisma.recruitmentCycle.findFirstOrThrow({ where: { publicSlug: "multi-dept" } });
  expect([...cycle.departments].sort()).toEqual(["MDIC", "SRHD"]);
});
