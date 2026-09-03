import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache, getSetting, setSetting } from "@/platform/settings/service";
import {
  groupForTemplate,
  resolveSenderForTemplate,
  resolveInheritedSender,
  saveSenderRule,
  clearSenderRule,
  listSenderRules,
  SenderRuleValidationError,
  SENDER_CATEGORIES,
} from "./sender-rules";

beforeEach(async () => {
  await resetDb();
  _resetSettingsCache();
});

describe("SENDER_CATEGORIES", () => {
  it("exposes a send-from category for every enqueued group (incl. support and incidents)", () => {
    const groups = SENDER_CATEGORIES.map((c) => c.group);
    expect(groups).toContain("support");
    expect(groups).toContain("incidents");
  });
});

describe("groupForTemplate", () => {
  it("maps a registered descriptor to its group", () => {
    expect(groupForTemplate("recruitment.acceptance")).toBe("recruitment");
    expect(groupForTemplate("compliance-reminder")).toBe("compliance");
  });

  it("maps campaign system keys to the campaign group", () => {
    expect(groupForTemplate("campaign")).toBe("campaign");
    expect(groupForTemplate("campaign:test")).toBe("campaign");
  });

  it("returns null for an unknown key", () => {
    expect(groupForTemplate("totally-unknown")).toBeNull();
  });
});

describe("resolveSenderForTemplate", () => {
  it("names the message from the org even when no rule matches, and picks no address", async () => {
    // No rule means no rule CHOSE AN ADDRESS, which is still true: fromEmail
    // stays null and the transport's own default carries the message exactly as
    // before. What changed is the name beside it. This used to return null
    // outright, and null is what put a bare address on ~4,347 messages.
    expect(await resolveSenderForTemplate("recruitment.acceptance")).toEqual({
      fromEmail: null,
      fromName: "HAVEN Free Clinic",
    });
  });

  it("applies a CATEGORY rule to a template in that group", async () => {
    await saveSenderRule(null, "CATEGORY", "recruitment", {
      fromEmail: "recruit@yale.edu",
      fromName: "HAVEN Recruitment",
    });
    expect(await resolveSenderForTemplate("recruitment.acceptance")).toEqual({
      fromEmail: "recruit@yale.edu",
      fromName: "HAVEN Recruitment",
    });
  });

  it("a TEMPLATE rule overrides the CATEGORY rule", async () => {
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "recruit@yale.edu" });
    await saveSenderRule(null, "TEMPLATE", "recruitment.acceptance", { fromEmail: "special@yale.edu" });
    const r = await resolveSenderForTemplate("recruitment.acceptance");
    expect(r?.fromEmail).toBe("special@yale.edu");
  });

  it("reflects a cleared rule (cache invalidated)", async () => {
    // Asserted on the ADDRESS, which is what a rule chooses. The name is now
    // always present via the org floor, so it can no longer tell a live rule
    // from a cleared one.
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "recruit@yale.edu" });
    expect((await resolveSenderForTemplate("recruitment.acceptance"))?.fromEmail).toBe(
      "recruit@yale.edu",
    );
    await clearSenderRule(null, "CATEGORY", "recruitment");
    expect((await resolveSenderForTemplate("recruitment.acceptance"))?.fromEmail).toBeNull();
  });
});

/**
 * THE ORG-NAME FLOOR: no email goes out bare.
 *
 * All six sender rules in production carry a null `fromName`, and most templates
 * have no rule at all, so every system message left as a bare address. There is
 * no "sending person" for a cron reminder to credit, and crediting one would be
 * a lie anyway, so the last resort is the organisation's own name.
 *
 * It is a NAME-ONLY floor. Which address a message leaves as, and which
 * transport signs it, are decided upstream and are not touched here: with no
 * rule the address stays null and the transport's own default carries the
 * message, exactly as it did when this function returned null outright.
 */
describe("the org-name floor", () => {
  it("names a rule that has no display name of its own", async () => {
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "recruit@yale.edu" });
    expect(await resolveSenderForTemplate("recruitment.acceptance")).toEqual({
      fromEmail: "recruit@yale.edu",
      fromName: "HAVEN Free Clinic",
    });
  });

  it("never displaces a name an admin set on the rule", async () => {
    // The floor is a floor, not an override. Same fixture as above with a name
    // on it; if these two ever agree, the floor is being applied too eagerly.
    await saveSenderRule(null, "CATEGORY", "recruitment", {
      fromEmail: "recruit@yale.edu",
      fromName: "HAVEN Recruitment",
    });
    await saveSenderRule(null, "TEMPLATE", "recruitment.rejection", {
      fromEmail: "recruit@yale.edu",
      fromName: "HAVEN Admissions",
    });
    expect((await resolveSenderForTemplate("recruitment.acceptance"))?.fromName).toBe(
      "HAVEN Recruitment",
    );
    expect((await resolveSenderForTemplate("recruitment.rejection"))?.fromName).toBe(
      "HAVEN Admissions",
    );
  });

  it("follows the org name when an admin renames the organisation", async () => {
    // Read through the normal settings path rather than baked in, so a rename
    // reaches every message. This is also what proves the assertions above are
    // reading the setting and not a constant that happens to match it.
    await setSetting("branding.orgName", "New Haven Free Clinic", null);
    expect((await resolveSenderForTemplate("recruitment.acceptance"))?.fromName).toBe(
      "New Haven Free Clinic",
    );
    expect((await resolveInheritedSender("recruitment.acceptance")).fromName).toBe(
      "New Haven Free Clinic",
    );
  });

  it("leaves the From bare when the org name is only whitespace", async () => {
    // z.string().min(1) accepts "   ", so this is reachable through the ordinary
    // settings screen. A blank display name on the wire is worse than none:
    // it is what a From with an empty name renders as, and it would look like a
    // bug rather than a plain address.
    await setSetting("branding.orgName", "   ", null);

    // With no rule there is nothing left to say, so the whole sender goes back
    // to null and the enqueue behaves exactly as it did before the floor.
    expect(await resolveSenderForTemplate("recruitment.acceptance")).toBeNull();

    // With a rule, the address still stands and only the name is dropped.
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "recruit@yale.edu" });
    expect(await resolveSenderForTemplate("recruitment.acceptance")).toEqual({
      fromEmail: "recruit@yale.edu",
      fromName: null,
    });
    expect((await resolveInheritedSender("recruitment.acceptance")).fromName).toBeNull();
  });

  it("reports the floor as the name a blank per-template field inherits", async () => {
    // resolveInheritedSender exists to tell an admin what leaving a field blank
    // will actually do. It would be showing them the wrong answer if it still
    // said "no name" while the send carried the org's.
    expect(await resolveInheritedSender("recruitment.acceptance")).toEqual({
      fromEmail: await getSetting<string>("email.sender"),
      fromName: "HAVEN Free Clinic",
    });
  });
});

describe("resolveInheritedSender", () => {
  it("falls back to the global email.sender setting when no category rule exists", async () => {
    await prisma.setting.create({ data: { key: "email.sender", value: "hfc.it@yale.edu" } });
    _resetSettingsCache();
    const r = await resolveInheritedSender("recruitment.acceptance");
    expect(r.fromEmail).toBe("hfc.it@yale.edu");
    // The address falls back to the global setting; the NAME falls back to the
    // org, which is the floor asserted in its own describe below.
    expect(r.fromName).toBe("HAVEN Free Clinic");
  });

  it("returns the category rule when present", async () => {
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "recruit@yale.edu" });
    const r = await resolveInheritedSender("recruitment.acceptance");
    expect(r.fromEmail).toBe("recruit@yale.edu");
  });
});

describe("saveSenderRule", () => {
  it("rejects a malformed email", async () => {
    await expect(
      saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "not-an-email" })
    ).rejects.toBeInstanceOf(SenderRuleValidationError);
  });

  it("upserts (one row per scope+target) and lists it", async () => {
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "a@yale.edu" });
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "b@yale.edu" });
    const rows = await listSenderRules();
    expect(rows).toHaveLength(1);
    expect(rows[0].fromEmail).toBe("b@yale.edu");
  });
});
