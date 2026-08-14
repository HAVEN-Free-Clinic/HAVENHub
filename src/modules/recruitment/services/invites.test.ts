/**
 * TDD tests for single-use recruitment invite links.
 *
 * The link admits ONE applicant to a cycle they could not otherwise apply to, so
 * someone can be recruited selectively after the deadline without reopening the
 * cycle to everyone.
 *
 * The lifecycle rules that matter, and why:
 *   - Only the hash is stored; createInvite returns the raw token once.
 *   - claimInvite burns it at FIRST SIGN-IN and binds it to that email, so the
 *     claimant can come back and finish a draft while the link itself is spent.
 *   - A second person cannot use a claimed link, but the ORIGINAL claimant still
 *     resolves as invited.
 *   - Expired and revoked invites never admit anyone.
 *   - An invite is scoped to its own cycle and cannot open a different one.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createInvite,
  claimInvite,
  isInvitedTo,
  revokeInvite,
  listInvites,
  peekInvite,
  invitedEmailsFor,
} from "./invites";

beforeEach(resetDb);

async function staff() {
  return prisma.person.create({ data: { name: "Recruiter", status: "ACTIVE" } });
}

async function closedCycle(slug = "closed-cycle") {
  const term = await prisma.term.create({
    data: {
      code: `T-${slug}`,
      name: "Term",
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-09-26"),
      status: "ACTIVE",
    },
  });
  const creator = await prisma.person.create({ data: { name: "Creator", status: "ACTIVE" } });
  return prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER",
      termId: term.id,
      title: "Closed Cycle",
      status: "CLOSED",
      publicSlug: slug,
      createdById: creator.id,
    },
  });
}

describe("createInvite", () => {
  it("returns a raw token and stores only its hash", async () => {
    const cycle = await closedCycle();
    const actor = await staff();

    const { token, invite } = await createInvite(actor.id, cycle.id, { label: "info session" });

    expect(token).toBeTruthy();
    const row = await prisma.recruitmentInvite.findUniqueOrThrow({ where: { id: invite.id } });
    // The raw token must be unrecoverable from the database.
    expect(row.tokenHash).not.toBe(token);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.label).toBe("info session");
    expect(row.createdById).toBe(actor.id);
  });

  it("defaults to expiring in 14 days", async () => {
    const cycle = await closedCycle();
    const actor = await staff();
    const { invite } = await createInvite(actor.id, cycle.id, {});
    const days = (invite.expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13);
    expect(days).toBeLessThan(15);
  });
});

describe("claimInvite", () => {
  it("admits the claimant and burns the token", async () => {
    const cycle = await closedCycle();
    const actor = await staff();
    const { token } = await createInvite(actor.id, cycle.id, {});

    const claimed = await claimInvite(token, "ada@yale.edu");

    expect(claimed?.cycleId).toBe(cycle.id);
    expect(await isInvitedTo(cycle.id, "ada@yale.edu")).toBe(true);
  });

  it("refuses a SECOND person once claimed, but still admits the original claimant", async () => {
    // The single-use guarantee and the resume path are the same mechanism: the
    // token is spent, yet the person it was spent on keeps their access.
    const cycle = await closedCycle();
    const actor = await staff();
    const { token } = await createInvite(actor.id, cycle.id, {});
    await claimInvite(token, "ada@yale.edu");

    expect(await claimInvite(token, "eve@yale.edu")).toBeNull();
    expect(await isInvitedTo(cycle.id, "eve@yale.edu")).toBe(false);
    expect(await isInvitedTo(cycle.id, "ada@yale.edu")).toBe(true);
  });

  it("is case- and whitespace-insensitive about the claimant's email", async () => {
    const cycle = await closedCycle();
    const actor = await staff();
    const { token } = await createInvite(actor.id, cycle.id, {});
    await claimInvite(token, "  Ada@Yale.edu ");
    expect(await isInvitedTo(cycle.id, "ada@yale.edu")).toBe(true);
  });

  it("refuses an unknown token", async () => {
    expect(await claimInvite("not-a-real-token", "ada@yale.edu")).toBeNull();
  });

  it("refuses an expired invite", async () => {
    const cycle = await closedCycle();
    const actor = await staff();
    const { token, invite } = await createInvite(actor.id, cycle.id, {});
    await prisma.recruitmentInvite.update({
      where: { id: invite.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await claimInvite(token, "ada@yale.edu")).toBeNull();
  });

  it("refuses a revoked invite", async () => {
    const cycle = await closedCycle();
    const actor = await staff();
    const { token, invite } = await createInvite(actor.id, cycle.id, {});
    await revokeInvite(actor.id, invite.id);
    expect(await claimInvite(token, "ada@yale.edu")).toBeNull();
  });
});

describe("isInvitedTo", () => {
  it("is scoped to the invite's own cycle", async () => {
    // An invite to one cycle must not act as a skeleton key for another that
    // happens to also be closed.
    const cycleA = await closedCycle("cycle-a");
    const cycleB = await closedCycle("cycle-b");
    const actor = await staff();
    const { token } = await createInvite(actor.id, cycleA.id, {});
    await claimInvite(token, "ada@yale.edu");

    expect(await isInvitedTo(cycleA.id, "ada@yale.edu")).toBe(true);
    expect(await isInvitedTo(cycleB.id, "ada@yale.edu")).toBe(false);
  });

  it("stops admitting a claimant once their invite is revoked", async () => {
    // Revoking after a claim is how staff withdraw an invitation issued in
    // error, so it has to reach the person who already claimed it.
    const cycle = await closedCycle();
    const actor = await staff();
    const { token, invite } = await createInvite(actor.id, cycle.id, {});
    await claimInvite(token, "ada@yale.edu");
    await revokeInvite(actor.id, invite.id);

    expect(await isInvitedTo(cycle.id, "ada@yale.edu")).toBe(false);
  });

  it("is false for anyone with no invite at all", async () => {
    const cycle = await closedCycle();
    expect(await isInvitedTo(cycle.id, "stranger@yale.edu")).toBe(false);
  });
});

describe("listInvites", () => {
  it("returns a cycle's invites newest first, with their status", async () => {
    const cycle = await closedCycle();
    const actor = await staff();
    await createInvite(actor.id, cycle.id, { label: "first" });
    await new Promise((r) => setTimeout(r, 5));
    const { token } = await createInvite(actor.id, cycle.id, { label: "second" });
    await claimInvite(token, "ada@yale.edu");

    const rows = await listInvites(cycle.id);
    expect(rows.map((r) => r.label)).toEqual(["second", "first"]);
    expect(rows[0].claimedByEmailLower).toBe("ada@yale.edu");
    expect(rows[0].createdBy.name).toBe("Recruiter");
  });
});

describe("peekInvite", () => {
  it("resolves a live invite to its cycle WITHOUT burning it", async () => {
    // The claim route has to know which cycle a link belongs to before the
    // visitor has signed in. Spending the token to find that out would burn it
    // on anyone who merely opened the link.
    const cycle = await closedCycle();
    const actor = await staff();
    const { token } = await createInvite(actor.id, cycle.id, {});

    const peeked = await peekInvite(token);
    expect(peeked?.cycle.publicSlug).toBe("closed-cycle");

    // Still claimable afterwards.
    expect(await claimInvite(token, "ada@yale.edu")).not.toBeNull();
  });

  it("returns null for unknown, expired, revoked, and already-claimed tokens", async () => {
    const cycle = await closedCycle();
    const actor = await staff();

    expect(await peekInvite("nope")).toBeNull();

    const revoked = await createInvite(actor.id, cycle.id, {});
    await revokeInvite(actor.id, revoked.invite.id);
    expect(await peekInvite(revoked.token)).toBeNull();

    const expired = await createInvite(actor.id, cycle.id, {});
    await prisma.recruitmentInvite.update({
      where: { id: expired.invite.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await peekInvite(expired.token)).toBeNull();

    const claimed = await createInvite(actor.id, cycle.id, {});
    await claimInvite(claimed.token, "ada@yale.edu");
    expect(await peekInvite(claimed.token)).toBeNull();
  });
});

describe("invitedEmailsFor", () => {
  it("returns the emails that accepted a live invite to the cycle", async () => {
    // Feeds the "Invited" marker on the review list: reviewers reading a stack
    // of applications need to know which ones arrived past the deadline by
    // invitation rather than through the open form.
    const cycle = await closedCycle();
    const actor = await staff();
    const a = await createInvite(actor.id, cycle.id, {});
    await claimInvite(a.token, "ada@yale.edu");
    // An outstanding, unclaimed invite contributes nobody.
    await createInvite(actor.id, cycle.id, {});

    const emails = await invitedEmailsFor(cycle.id);
    expect([...emails]).toEqual(["ada@yale.edu"]);
  });

  it("drops a withdrawn invite, so a revoked application stops being marked", async () => {
    const cycle = await closedCycle();
    const actor = await staff();
    const { token, invite } = await createInvite(actor.id, cycle.id, {});
    await claimInvite(token, "ada@yale.edu");
    await revokeInvite(actor.id, invite.id);

    expect((await invitedEmailsFor(cycle.id)).size).toBe(0);
  });

  it("does not leak invitees across cycles", async () => {
    const cycleA = await closedCycle("cycle-a");
    const cycleB = await closedCycle("cycle-b");
    const actor = await staff();
    const { token } = await createInvite(actor.id, cycleA.id, {});
    await claimInvite(token, "ada@yale.edu");

    expect((await invitedEmailsFor(cycleB.id)).size).toBe(0);
  });
});
