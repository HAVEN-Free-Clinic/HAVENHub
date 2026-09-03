import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE ALLOWLIST AND ADDRESS LIST THESE CASES ROUTE AGAINST, declared here rather
 * than borrowed from the shipped defaults.
 *
 * What this file tests is which configured sender addresses would CHANGE
 * TRANSPORT if email.transport were flipped to maileroo. That question is about
 * the routing rules, not about which real domain Maileroo has verified this
 * month -- and borrowing the shipped table is what coupled thirteen tests in
 * transport.test.ts and admin/services/email.test.ts to a Maileroo dashboard
 * state, which then changed under them.
 *
 * The `.example` TLD is reserved by RFC 2606 and can never become a real sending
 * domain, so nothing below can quietly start meaning something about production.
 *
 * The SHAPE of the real deployment is what is reproduced, and it is the whole
 * point: several sender rules on ONE domain, some on mailboxes Graph carries and
 * some not. That is the situation a domain-keyed check could not describe.
 *
 * Set through the environment rather than by mocking ./sending-domains, so the
 * real chain runs underneath: config.ts's boot checks, both parsers, and the
 * module-level maps signingTransportFor reads. vitest.setup.ts re-claims both
 * names before every test file, so this cannot leak.
 */
const { SIGNED_DOMAIN, PINNED_ONE, PINNED_TWO } = vi.hoisted(() => {
  const fixture = {
    /** Maileroo-signed, standing in for yale.edu. Every address below is on it. */
    SIGNED_DOMAIN: "maileroo-signed.example",
    PINNED_ONE: "clinic@maileroo-signed.example",
    PINNED_TWO: "admin@maileroo-signed.example",
  };
  process.env.SENDING_DOMAINS = `${fixture.SIGNED_DOMAIN}:maileroo`;
  process.env.GRAPH_SENDER_ADDRESSES = `${fixture.PINNED_ONE},${fixture.PINNED_TWO}`;
  return fixture;
});

import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache } from "@/platform/settings/service";
import { _resetSenderRulesCache } from "./sender-rules";
import { emailRoutingGap } from "./routing-gap";

/** On the Maileroo-signed domain but NOT on the Graph address list. */
const UNPINNED_ONE = `recruitment@${SIGNED_DOMAIN}`;
const UNPINNED_TWO = `shifts@${SIGNED_DOMAIN}`;
/** The connected Graph mailbox, Graph-routed with no list entry. */
const MAILBOX = `mailer@${SIGNED_DOMAIN}`;

beforeEach(async () => {
  await resetDb();
  _resetSettingsCache();
  _resetSenderRulesCache();
  // Under "log" the component renders nothing, so every case here sets a live
  // transport. "graph" is production's current value and the state the whole
  // check exists for: routing is inert, so nothing is wrong yet, and that is
  // exactly when the list is worth reading.
  await prisma.setting.create({ data: { key: "email.transport", value: "graph" } });
  await prisma.setting.create({ data: { key: "email.sender", value: PINNED_ONE } });
});

async function rule(
  scope: "CATEGORY" | "TEMPLATE",
  target: string,
  fromEmail: string
): Promise<void> {
  await prisma.emailSenderRule.create({ data: { scope, target, fromEmail } });
  _resetSenderRulesCache();
}

const addresses = (gap: Awaited<ReturnType<typeof emailRoutingGap>>) =>
  (gap?.entries ?? []).map((e) => e.address);

describe("emailRoutingGap", () => {
  it("lists EXACTLY the sender-rule addresses that are not Graph-routed", async () => {
    // The real deployment's shape: six rules, three distinct mailboxes, all on
    // one domain. Two of them are on the Graph list and two are not.
    await rule("CATEGORY", "campaign", PINNED_ONE);
    await rule("CATEGORY", "incidents", PINNED_ONE);
    await rule("CATEGORY", "compliance", PINNED_TWO);
    await rule("CATEGORY", "recruitment", UNPINNED_ONE);
    await rule("CATEGORY", "shift", UNPINNED_TWO);
    await rule("TEMPLATE", "compliance-reminder", PINNED_TWO);

    const gap = await emailRoutingGap();
    // EXACTLY: the two unpinned ones are named, and neither pinned one is. A
    // check that listed everything would be as useless as one that listed
    // nothing, and both would pass a test that only asserted "not empty".
    expect(addresses(gap)).toEqual([UNPINNED_ONE, UNPINNED_TWO].sort());
    expect(addresses(gap)).not.toContain(PINNED_ONE);
    expect(addresses(gap)).not.toContain(PINNED_TWO);
    // And the ones that stay are counted, so the card can say what is unaffected.
    expect(gap?.graphRoutedCount).toBe(2);
  });

  it("is empty when every sender-rule address is Graph-routed", async () => {
    await rule("CATEGORY", "campaign", PINNED_ONE);
    await rule("CATEGORY", "compliance", PINNED_TWO);
    await rule("TEMPLATE", "compliance-reminder", PINNED_TWO);

    const gap = await emailRoutingGap();
    expect(gap?.entries).toEqual([]);
    expect(gap?.graphRoutedCount).toBe(2);
  });

  it("is empty when there are no sender rules at all", async () => {
    const gap = await emailRoutingGap();
    expect(gap?.entries).toEqual([]);
    expect(gap?.graphRoutedCount).toBe(0);
  });

  it("names every rule that sends as one address, rather than repeating the address", async () => {
    // Three of the clinic's six rules share one mailbox. Listing it three times
    // would read as three problems; naming it once with its three uses is what
    // tells an admin how much moves.
    await rule("CATEGORY", "campaign", UNPINNED_ONE);
    await rule("CATEGORY", "incidents", UNPINNED_ONE);
    await rule("TEMPLATE", "compliance-reminder", UNPINNED_ONE);

    const gap = await emailRoutingGap();
    expect(gap?.entries).toHaveLength(1);
    // The admin's own words for a category, and the raw key for a template.
    expect(gap?.entries[0].usedBy).toEqual([
      "Campaigns",
      "Incident Reports",
      "Template: compliance-reminder",
    ]);
  });

  it("counts one address written two ways as one address moving", async () => {
    await rule("CATEGORY", "campaign", UNPINNED_ONE);
    await rule("CATEGORY", "incidents", UNPINNED_ONE.toUpperCase());
    const gap = await emailRoutingGap();
    expect(gap?.entries).toHaveLength(1);
    expect(gap?.entries[0].usedBy).toHaveLength(2);
  });

  it("treats the connected Graph mailbox as Graph-routed, with no list entry", async () => {
    await prisma.mailCredential.create({
      data: { id: "mailer", refreshToken: "rt", account: MAILBOX },
    });
    await rule("CATEGORY", "campaign", MAILBOX);

    const gap = await emailRoutingGap();
    expect(addresses(gap)).toEqual([]);
    expect(gap?.graphRoutedCount).toBe(1);
  });

  it("reports that same address as moving when no mailbox is connected", async () => {
    // The other polarity. Without it the test above passes against a check that
    // treats this address, or its whole domain, as Graph-routed unconditionally.
    await rule("CATEGORY", "campaign", MAILBOX);
    const gap = await emailRoutingGap();
    expect(addresses(gap)).toEqual([MAILBOX]);
    expect(gap?.graphRoutedCount).toBe(0);
  });

  it("reports the global default separately, since it is not a sender rule", async () => {
    // It is the From for every category with no rule of its own -- `auth`
    // included, which is magic-link logins. A card that named the moving rules
    // while login mail moved unmentioned would understate the blast radius by
    // the one thing nobody can afford to lose. It stays OUT of `entries` so that
    // list remains exactly what it claims to be.
    await prisma.setting.update({
      where: { key: "email.sender" },
      data: { value: UNPINNED_ONE },
    });
    _resetSettingsCache();
    await rule("CATEGORY", "compliance", PINNED_TWO);

    const gap = await emailRoutingGap();
    expect(gap?.entries).toEqual([]);
    expect(gap?.globalSender).toEqual({ address: UNPINNED_ONE, graphRouted: false });
  });

  it("marks the global default as staying put when it IS Graph-routed", async () => {
    const gap = await emailRoutingGap();
    expect(gap?.globalSender).toEqual({ address: PINNED_ONE, graphRouted: true });
  });

  it("carries the transport as it stands, so the copy can say pending or done", async () => {
    expect((await emailRoutingGap())?.transport).toBe("graph");
    await prisma.setting.update({
      where: { key: "email.transport" },
      data: { value: "maileroo" },
    });
    _resetSettingsCache();
    expect((await emailRoutingGap())?.transport).toBe("maileroo");
  });

  it("reports the SAME list whichever transport is selected", async () => {
    // The routing rules do not depend on the setting; only whether they are
    // being applied yet does. Rendering decides what to say about that (see
    // routing-gap-alert.tsx), so a change of transport must not change the list
    // -- otherwise the warning shown before the flip would not describe what
    // happens after it, which is the one thing it is for.
    await rule("CATEGORY", "recruitment", UNPINNED_ONE);
    const before = addresses(await emailRoutingGap());
    await prisma.setting.update({
      where: { key: "email.transport" },
      data: { value: "maileroo" },
    });
    _resetSettingsCache();
    expect(addresses(await emailRoutingGap())).toEqual(before);
  });

  it("labels a CATEGORY rule whose target is no longer a known category", async () => {
    // EmailSenderRule.target is a free string column, so a renamed or dropped
    // group leaves a row behind. It must still appear, under its raw target,
    // rather than crashing the card or vanishing from it.
    await rule("CATEGORY", "some-retired-group", UNPINNED_ONE);
    const gap = await emailRoutingGap();
    expect(gap?.entries[0].usedBy).toEqual(["some-retired-group"]);
  });
});
