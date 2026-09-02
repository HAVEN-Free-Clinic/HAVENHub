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
import {
  countNodesAction, searchPeopleAction, excludePersonAction,
  saveAction, pastedEmailsAction,
} from "./actions";
import { MAX_PASTED_EMAILS } from "@/platform/email/campaigns/service";

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

/**
 * The actions that must NOT navigate when they refuse.
 *
 * Every navigation out of this page destroys unsaved client state: the compose
 * form's subject and body live in TemplateEditor's useState and the whole
 * audience tree lives in AudienceBuilder's useState, and a server action that
 * redirects replaces the page tree below AppShell through the
 * (app)/loading.tsx Suspense boundary. So a REJECTED save must hand its
 * problems back to be rendered in place, the way previewAction already does. A
 * mistyped template variable is the most ordinary way to reach this path, and
 * before the fix it cost the sender everything they had typed since their last
 * save.
 *
 * The successful path still redirects, and must: there is nothing left to lose
 * once the work is stored, and the redirect is what re-seeds the editor.
 */
describe("saveAction", () => {
  const AUDIENCE = JSON.stringify({
    recordType: "PERSON",
    match: "ALL",
    conditions: [{ field: "status", op: "eq", value: "ACTIVE" }],
  });

  function form(fields: Record<string, string>): FormData {
    const fd = new FormData();
    fd.set("tab", "compose");
    fd.set("name", "A campaign");
    fd.set("subject", "Hello");
    fd.set("body", "<p>Hello</p>");
    fd.set("audience", AUDIENCE);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  }

  async function sender() {
    const actor = await prisma.person.create({ data: { name: "Sender" } });
    await signIn(actor.id);
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send_unrestricted");
    return actor;
  }

  it("returns the problems from a rejected save instead of navigating away from them", async () => {
    await sender();
    const c = await createDraft(null, "Original name", { scopeId: null });

    // The ordinary way in: a mistyped variable name.
    const result = await saveAction(c.id, null, null, form({ subject: "Hi {{ firstNam }}" }));

    expect(result).toEqual({ problems: ["Unknown variable in subject: firstNam"] });
    // Nothing was written, so the sender's unsaved work is still the only copy
    // of it, and it is still on screen.
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.subject).toBe("");
    expect(after.name).toBe("Original name");
  });

  it("still redirects when the save succeeds", async () => {
    await sender();
    const c = await createDraft(null, "Original name", { scopeId: null });

    await expect(saveAction(c.id, null, null, form({}))).rejects.toThrow("NEXT_REDIRECT");

    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.subject).toBe("Hello");
    expect(after.name).toBe("A campaign");
  });

  it("returns a scope refusal instead of navigating away from the unsaved work", async () => {
    const actor = await prisma.person.create({ data: { name: "Sender" } });
    await signIn(actor.id);
    // Holds outreach.send, but was never granted this scope.
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send");
    const scope = await createScope(null, {
      name: "Someone else's scope",
      audience: { recordType: "PERSON", match: "ALL", conditions: [{ field: "status", op: "eq", value: "ACTIVE" }] },
    });
    const c = await createDraft(null, "Not mine", { scopeId: scope.id });

    const result = await saveAction(c.id, scope.id, null, form({}));

    expect(result).toEqual({ problems: ["You have not been granted that audience scope."] });
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.subject).toBe("");
  });

  // The name was previously guarded by the browser's `required` attribute,
  // which cannot report anything the server knows and which left the sender
  // stuck on a control that is invisible whenever the Compose tab is not the
  // one showing. Now that a refusal renders in place, it is validated here like
  // everything else.
  it("refuses an empty campaign name and keeps the stored one", async () => {
    await sender();
    const c = await createDraft(null, "Original name", { scopeId: null });

    const result = await saveAction(c.id, null, null, form({ name: "   " }));

    expect(result).toEqual({ problems: ["Enter a campaign name."] });
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.name).toBe("Original name");
  });
});

describe("pastedEmailsAction", () => {
  async function sender() {
    const actor = await prisma.person.create({ data: { name: "Sender" } });
    await signIn(actor.id);
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send_unrestricted");
  }

  it("returns the problem for an over-long block instead of destroying the block", async () => {
    await sender();
    const c = await createDraft(null, "Big paste", { scopeId: null });
    await prisma.emailCampaign.update({
      where: { id: c.id },
      data: { pastedEmails: ["already@example.com"] },
    });

    const tooMany = Array.from({ length: MAX_PASTED_EMAILS + 1 }, (_, i) => `p${i}@example.com`);
    const formData = new FormData();
    formData.set("pastedEmails", tooMany.join("\n"));

    const result = await pastedEmailsAction(c.id, null, null, formData);

    expect(result).toEqual({
      problems: [
        `That is ${MAX_PASTED_EMAILS + 1} addresses. A campaign may hold at most ${MAX_PASTED_EMAILS}.`,
      ],
    });
    // The stored block is untouched, and because nothing navigated the rejected
    // block is still in the textarea for the sender to trim.
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.pastedEmails).toEqual(["already@example.com"]);
  });

  it("still redirects when the block is accepted", async () => {
    await sender();
    const c = await createDraft(null, "Paste", { scopeId: null });

    const formData = new FormData();
    formData.set("pastedEmails", "sam@example.com, pat@example.com");
    await expect(pastedEmailsAction(c.id, null, null, formData)).rejects.toThrow("NEXT_REDIRECT");

    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.pastedEmails).toEqual(["sam@example.com", "pat@example.com"]);
  });
});
