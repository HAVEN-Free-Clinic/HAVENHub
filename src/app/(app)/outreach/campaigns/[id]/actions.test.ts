/**
 * countNodesAction: what the builder's live counts do when something is wrong.
 *
 * The counts fire automatically on every editor load, so every failure here has
 * to degrade to "no numbers" rather than reject a server action. That is not
 * leniency: the page's own loader already ran the same scope check before the
 * builder could mount (see page.tsx), so a refusal reaching this action means a
 * grant changed mid-session, and an empty map is the fail-closed answer. Every
 * action that actually sends something still refuses loudly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const e = Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${url}` });
    throw e;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/platform/auth/session", () => ({ requireAnyPermission: vi.fn() }));

import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { requireAnyPermission } from "@/platform/auth/session";
import { createDraft } from "@/platform/email/campaigns/service";
import { createScope } from "@/platform/email/audience/scopes";
import * as rbac from "@/platform/rbac/engine";
import type { Audience } from "@/platform/email/audience/types";
import { countNodesAction, searchPeopleAction, excludePersonAction } from "./actions";

beforeEach(resetDb);
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(requireAnyPermission).mockReset();
});

async function signIn(personId: string) {
  vi.mocked(requireAnyPermission).mockResolvedValue({ personId } as never);
}

const NAMED: Audience = {
  recordType: "PERSON",
  match: "ALL",
  conditions: [{ field: "name", op: "isNotEmpty" }],
};

describe("countNodesAction", () => {
  it("counts a campaign the sender may act on", async () => {
    await prisma.person.create({ data: { name: "Sam", contactEmail: "s@x.com", status: "ACTIVE" } });
    const actor = await prisma.person.create({ data: { name: "Sender" } });
    await signIn(actor.id);
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send_unrestricted");

    const c = await createDraft(null, "Counts", { scopeId: null });
    expect(await countNodesAction(c.id, null, NAMED)).toEqual({ root: 2, "0": 2 });
  });

  // The legacy state field-picker.tsx renders as "Unknown field". It passes
  // isAudience (a leaf needs only a string `field`), so it reaches the compiler
  // and personFieldWhere throws on it. Before this was caught, opening any
  // campaign holding one rejected a server action on page load, for an audience
  // the builder itself is built to display and let you remove.
  it("returns no counts for an audience naming a field that no longer exists", async () => {
    await prisma.person.create({ data: { name: "Sam", contactEmail: "s@x.com", status: "ACTIVE" } });
    const actor = await prisma.person.create({ data: { name: "Sender" } });
    await signIn(actor.id);
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send_unrestricted");

    const c = await createDraft(null, "Legacy", { scopeId: null });
    const legacy = {
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "aFieldThatNoLongerExists", op: "eq", value: "x" }],
    } as Audience;

    await expect(countNodesAction(c.id, null, legacy)).resolves.toEqual({});
  });

  it("returns no counts to a sender whose scope grant has gone away", async () => {
    await prisma.person.create({ data: { name: "Sam", contactEmail: "s@x.com", status: "ACTIVE" } });
    const actor = await prisma.person.create({ data: { name: "Sender" } });
    await signIn(actor.id);
    // Holds outreach.send, but was never granted this scope.
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send");

    const scope = await createScope(null, {
      name: "Someone else's scope",
      audience: { recordType: "PERSON", match: "ALL", conditions: [{ field: "status", op: "eq", value: "ACTIVE" }] },
    });
    const c = await createDraft(null, "Not mine", { scopeId: scope.id });

    await expect(countNodesAction(c.id, scope.id, NAMED)).resolves.toEqual({});
  });

  it("returns no counts for a malformed tree rather than compiling it", async () => {
    const actor = await prisma.person.create({ data: { name: "Sender" } });
    await signIn(actor.id);
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send_unrestricted");

    const c = await createDraft(null, "Malformed", { scopeId: null });
    const malformed = { recordType: "PERSON", match: "ALL", conditions: [{ nope: 1 }] } as unknown as Audience;

    await expect(countNodesAction(c.id, null, malformed)).resolves.toEqual({});
  });
});

/**
 * The manual-include search box.
 *
 * The scope bound itself is enforced in the service and tested there (a search
 * that ignored the campaign's scope would let a scoped sender enumerate the
 * whole directory by typing letters). What this action adds is the permission
 * re-check, and its answer to a sender who fails it: an empty list, the same
 * fail-closed degrade countNodesAction makes, because both run automatically
 * against a page whose loader already applied the identical check.
 */
describe("searchPeopleAction", () => {
  it("searches for a sender who may act on the campaign", async () => {
    await prisma.person.create({ data: { name: "Rivera Sam", contactEmail: "s@x.com", status: "ACTIVE" } });
    const actor = await prisma.person.create({ data: { name: "Sender" } });
    await signIn(actor.id);
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send_unrestricted");

    const c = await createDraft(null, "Search", { scopeId: null });
    expect(await searchPeopleAction(c.id, null, "Rivera")).toEqual([
      { personId: expect.any(String), name: "Rivera Sam", email: "s@x.com" },
    ]);
  });

  it("returns nobody to a sender whose scope grant has gone away", async () => {
    await prisma.person.create({ data: { name: "Rivera Sam", contactEmail: "s@x.com", status: "ACTIVE" } });
    const actor = await prisma.person.create({ data: { name: "Sender" } });
    await signIn(actor.id);
    // Holds outreach.send, but was never granted this scope.
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send");

    const scope = await createScope(null, {
      name: "Someone else's scope",
      audience: { recordType: "PERSON", match: "ALL", conditions: [{ field: "status", op: "eq", value: "ACTIVE" }] },
    });
    const c = await createDraft(null, "Not mine", { scopeId: scope.id });

    await expect(searchPeopleAction(c.id, scope.id, "Rivera")).resolves.toEqual([]);
  });
});

/**
 * The mutating manual-list actions.
 *
 * Unlike the search, these must refuse LOUDLY rather than degrade: they change
 * who a campaign mails, so a sender whose grant has gone away gets the same
 * ?error= redirect the other seven mutating actions give, and nothing is
 * written on the way out.
 */
describe("excludePersonAction", () => {
  it("writes nothing and redirects when the sender's scope grant has gone away", async () => {
    const target = await prisma.person.create({
      data: { name: "Target", contactEmail: "t@x.com", status: "ACTIVE" },
    });
    const actor = await prisma.person.create({ data: { name: "Sender" } });
    await signIn(actor.id);
    // Holds outreach.send, but was never granted this scope.
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send");

    const scope = await createScope(null, {
      name: "Someone else's scope",
      audience: { recordType: "PERSON", match: "ALL", conditions: [{ field: "status", op: "eq", value: "ACTIVE" }] },
    });
    const c = await createDraft(null, "Not mine", { scopeId: scope.id });

    const formData = new FormData();
    formData.set("personId", target.id);
    await expect(excludePersonAction(c.id, scope.id, formData)).rejects.toThrow("NEXT_REDIRECT");

    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.excludePersonIds).toEqual([]);
    expect(after.includePersonIds).toEqual([]);
  });
});
