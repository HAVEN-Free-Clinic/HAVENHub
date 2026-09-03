/**
 * The verified-domain allowlist.
 *
 * Every decision is asserted at BOTH polarities. A test that only checked "a
 * havenfreeclinic.org From is Maileroo-signable" would pass against an
 * implementation that answered "maileroo" for everything, which is exactly the
 * unconditional pin this allowlist replaces.
 */
import { describe, expect, it } from "vitest";
import { decideSigningTransport } from "./address";
import {
  DEFAULT_GRAPH_SENDER_ADDRESSES,
  DEFAULT_SENDING_DOMAINS,
  GRAPH_SENDER_ADDRESSES,
  SENDING_DOMAINS,
  domainOf,
  parseGraphSenderAddresses,
  parseSendingDomains,
  signingTransportFor,
} from "./sending-domains";

describe("the default allowlist", () => {
  it("maps each domain to the transport that can actually sign for it", () => {
    // Both are Maileroo since 2026-09-02, when Maileroo verified yale.edu. The
    // map still has to exist rather than collapsing to "Maileroo signs
    // everything": a domain absent from it falls back to the pinned sender, and
    // "yale.edu:graph" is the documented reversal if Maileroo disables it again.
    expect(DEFAULT_SENDING_DOMAINS["havenfreeclinic.org"]).toBe("maileroo");
    expect(DEFAULT_SENDING_DOMAINS["yale.edu"]).toBe("maileroo");
  });

  it("is what the module resolves to when no override is configured", () => {
    expect(SENDING_DOMAINS.get("havenfreeclinic.org")).toBe("maileroo");
    expect(SENDING_DOMAINS.get("yale.edu")).toBe("maileroo");
  });
});

describe("parseSendingDomains", () => {
  it("falls back to the default table when the override is unset or empty", () => {
    // The empty case is load-bearing, not cosmetic: vitest.setup.ts claims every
    // external-service env name as "" so a local run cannot differ from CI, and
    // an unset Vercel variable also arrives as "". If either emptied the
    // allowlist, every send would silently fall back to the pinned sender.
    for (const spec of [undefined, "", "   "]) {
      const map = parseSendingDomains(spec);
      expect(map.get("havenfreeclinic.org")).toBe("maileroo");
      expect(map.get("yale.edu")).toBe("maileroo");
    }
  });

  it("REPLACES the default table rather than merging into it", () => {
    const map = parseSendingDomains("example.org:maileroo");
    expect(map.get("example.org")).toBe("maileroo");
    // Both defaults are gone: an operator narrowing the allowlist must get the
    // narrowing they asked for, not the union with a stale built-in.
    expect(map.get("havenfreeclinic.org")).toBeUndefined();
    expect(map.get("yale.edu")).toBeUndefined();
  });

  it("can move yale.edu back to Graph without a code edit, if Maileroo disables it again", () => {
    // The reversal, now that the default is Maileroo. This is the lever an
    // operator reaches for the day a send starts returning "The domain
    // 'yale.edu' is currently disabled", and it must not need a pull request.
    const map = parseSendingDomains("havenfreeclinic.org:maileroo,yale.edu:graph");
    expect(map.get("yale.edu")).toBe("graph");
    expect(map.get("havenfreeclinic.org")).toBe("maileroo");
  });

  it("lowercases domains and tolerates whitespace around entries", () => {
    const map = parseSendingDomains(" HavenFreeClinic.ORG:maileroo , Yale.edu:graph ");
    expect(map.get("havenfreeclinic.org")).toBe("maileroo");
    expect(map.get("yale.edu")).toBe("graph");
  });

  it("reads a trailing comma and blank segments as the operator meant them", () => {
    // Pinned on BOTH halves: config.ts's boot check must accept exactly what this
    // accepts. It used to reject a trailing comma, which turned a typo on the
    // emergency lever into an app-wide cold-start failure.
    expect(parseSendingDomains("yale.edu:graph,")).toEqual(
      new Map([["yale.edu", "graph"]])
    );
    expect(parseSendingDomains("havenfreeclinic.org:maileroo, ,yale.edu:graph")).toEqual(
      new Map([
        ["havenfreeclinic.org", "maileroo"],
        ["yale.edu", "graph"],
      ])
    );
  });

  it("falls back to the default table when a non-empty spec yields no domains", () => {
    // config.ts REFUSES to boot on this, so it is unreachable in a booted app.
    // The parser still has to pick a direction, and an empty map is the worst
    // one: it silently pins every send. Defaulting keeps the two halves agreeing
    // that the input is degenerate, and differing only in how loudly they say so.
    for (const spec of [",", " , ", ",,", "nocolon", "yale.edu:smtp"]) {
      const map = parseSendingDomains(spec);
      expect(map.get("havenfreeclinic.org"), spec).toBe("maileroo");
      expect(map.get("yale.edu"), spec).toBe("maileroo");
    }
  });

  it("takes the LAST verdict when a domain is listed twice", () => {
    // Last-wins, documented rather than rejected: it is the ordinary convention
    // for a key/value list, and it is the one ambiguous input neither this parser
    // nor config.ts's boot check flags.
    expect(parseSendingDomains("yale.edu:graph,yale.edu:maileroo").get("yale.edu")).toBe(
      "maileroo"
    );
    expect(parseSendingDomains("yale.edu:maileroo,yale.edu:graph").get("yale.edu")).toBe("graph");
  });

  it("drops a malformed entry without taking the rest of the override with it", () => {
    // config.ts refuses to boot on a malformed override, so this is the
    // belt-and-braces half: one bad pair must not empty the allowlist and send
    // every message to the pinned fallback.
    const map = parseSendingDomains("havenfreeclinic.org:maileroo,yale.edu:smtp,nocolon");
    expect(map.get("havenfreeclinic.org")).toBe("maileroo");
    expect(map.get("yale.edu")).toBeUndefined();
    expect(map.size).toBe(1);
  });
});

describe("domainOf", () => {
  it("returns the lowercased domain of a real address", () => {
    expect(domainOf("Recruitment@HavenFreeClinic.org")).toBe("havenfreeclinic.org");
    expect(domainOf("  hfc.it@yale.edu  ")).toBe("yale.edu");
  });

  it("returns null for anything that is not an address with a domain", () => {
    for (const value of [undefined, null, "", "   ", "noatsign", "@nolocal.org", "trailing@"]) {
      expect(domainOf(value)).toBeNull();
    }
  });
});

describe("signingTransportFor", () => {
  it("answers maileroo for a Maileroo-signable From", () => {
    expect(signingTransportFor("recruitment@havenfreeclinic.org")).toBe("maileroo");
  });

  it("answers maileroo for yale.edu too, since Maileroo verified it", () => {
    // signingTransportFor reads the module-level map, and no domain routes to
    // Graph in the shipped default any more. That the map CAN carry "graph" is
    // covered by the parseSendingDomains cases above, including the reversal
    // lever; what is left to pin here is that the lookup passes the value
    // through rather than hardcoding a transport per domain.
    expect(signingTransportFor("hfc.it@yale.edu")).toBe("maileroo");
  });

  it("answers null for a domain that is not on the allowlist", () => {
    expect(signingTransportFor("someone@example.com")).toBeNull();
  });

  it("answers null when there is no From at all", () => {
    expect(signingTransportFor(undefined)).toBeNull();
    expect(signingTransportFor(null)).toBeNull();
    expect(signingTransportFor("")).toBeNull();
  });

  it("does not match a subdomain of an allowlisted domain", () => {
    // A subdomain publishes its own SPF/DKIM records, so inheriting the parent's
    // verdict would be a guess. mail.yale.edu is not yale.edu.
    expect(signingTransportFor("noreply@mail.yale.edu")).toBeNull();
    expect(signingTransportFor("noreply@notyale.edu")).toBeNull();
  });

  it("is case-insensitive about the domain", () => {
    expect(signingTransportFor("HFC.IT@Yale.Edu")).toBe("maileroo");
  });
});

// ---------------------------------------------------------------------------
// GRAPH_SENDER_ADDRESSES: the address-level rule
// ---------------------------------------------------------------------------

describe("parseGraphSenderAddresses", () => {
  it("ships EMPTY, because which mailboxes an org owns is not a shipped constant", () => {
    // Deliberate, and the reason the gap check in routing-gap.ts exists: an
    // empty list routes every address by domain, which on a Maileroo deployment
    // moves every configured sender to Maileroo. Safe, but decided by nobody
    // until an admin sees the list.
    expect(DEFAULT_GRAPH_SENDER_ADDRESSES).toEqual([]);
    expect(GRAPH_SENDER_ADDRESSES.size).toBe(0);
  });

  it("reads unset, empty and whitespace-only as an empty list", () => {
    // An unset Vercel variable arrives as "", and vitest.setup.ts claims every
    // external-service env name as "" so a local run cannot diverge from CI.
    //
    // This asserts the RESULT and nothing more, and says so rather than
    // implying more. It cannot distinguish "not configured" from "configured to
    // nothing", because with an empty shipped default the two produce the same
    // set: stripping both default fallbacks from parseGraphSenderAddresses
    // leaves this green. The distinction is real and IS enforced, one layer up
    // at config.ts's `addresses === 0` refusal, whose own test does die when it
    // is removed -- so the claim is made where it bites instead of being
    // restated here where it cannot.
    for (const spec of [undefined, "", "   "]) {
      expect(parseGraphSenderAddresses(spec), String(spec)).toEqual(new Set());
    }
  });

  it("reads a list, lowercasing and trimming each entry", () => {
    const set = parseGraphSenderAddresses(" HFC.Admin@Yale.edu , hfc.recruitment@yale.edu ");
    expect(set).toEqual(new Set(["hfc.admin@yale.edu", "hfc.recruitment@yale.edu"]));
  });

  it("reads a single address with no comma at all", () => {
    expect(parseGraphSenderAddresses("hfc.admin@yale.edu")).toEqual(
      new Set(["hfc.admin@yale.edu"])
    );
  });

  it("tolerates a trailing comma, which config.ts also accepts", () => {
    // The two halves must agree on this or the strict one refuses to boot on
    // input this one reads correctly, which is what a trailing comma on the
    // SENDING_DOMAINS lever once did to the whole app.
    expect(parseGraphSenderAddresses("hfc.admin@yale.edu,")).toEqual(
      new Set(["hfc.admin@yale.edu"])
    );
  });

  it("REPLACES the default rather than merging into it", () => {
    // Recorded now rather than inferred later: with an empty default the two
    // behaviours agree, so nothing else would catch a drift to merge semantics.
    const set = parseGraphSenderAddresses("only@example.com");
    expect(set).toEqual(new Set(["only@example.com"]));
  });

  it("skips an entry written as a SENDING_DOMAINS pair, which EMAIL_RE alone accepts", () => {
    // EMAIL_RE is deliberately permissive about the domain part, so it reads
    // "x@example.com:graph" as an address whose domain is "example.com:graph".
    // The mistake is invited by the variable sitting next to this one in
    // .env.example. config.ts refuses to boot on it; this half must agree that
    // it is not a usable entry, or the two disagree about the same input.
    expect(parseGraphSenderAddresses("x@example.com:graph")).toEqual(new Set());
    expect(parseGraphSenderAddresses("ok@example.com,x@example.com:graph")).toEqual(
      new Set(["ok@example.com"])
    );
  });
});

describe("the address rule out-ranks the domain table", () => {
  // The whole reason this rule exists, at both polarities on ONE domain.
  // yale.edu is Maileroo-signed in the shipped table; a shared clinic mailbox on
  // it must still go through Graph, and a personal one on it must not.
  const graphAddresses = new Set(["hfc.admin@yale.edu"]);
  const domains = SENDING_DOMAINS;

  it("routes a listed address to Graph though its domain says Maileroo", () => {
    expect(domains.get("yale.edu")).toBe("maileroo");
    expect(decideSigningTransport("hfc.admin@yale.edu", { graphAddresses, domains })).toEqual({
      transport: "graph",
      rule: "address",
    });
  });

  it("routes an UNLISTED address on that same domain to Maileroo", () => {
    // Without this the test above passes against an implementation that sends
    // all of yale.edu to Graph, which is the thing this change replaced.
    expect(decideSigningTransport("alice@yale.edu", { graphAddresses, domains })).toEqual({
      transport: "maileroo",
      rule: "domain",
    });
  });

  it("routes the connected mailbox to Graph with no list entry", () => {
    expect(graphAddresses.has("hfc.it@yale.edu")).toBe(false);
    expect(
      decideSigningTransport("hfc.it@yale.edu", {
        graphAddresses,
        domains,
        graphMailbox: "hfc.it@yale.edu",
      })
    ).toEqual({ transport: "graph", rule: "mailbox" });
  });

  it("routes that same address by domain when it is NOT the connected mailbox", () => {
    expect(
      decideSigningTransport("hfc.it@yale.edu", { graphAddresses, domains, graphMailbox: null })
    ).toEqual({ transport: "maileroo", rule: "domain" });
  });

  it("compares the connected mailbox case- and whitespace-blind", () => {
    expect(
      decideSigningTransport("HFC.IT@Yale.Edu", {
        graphAddresses,
        domains,
        graphMailbox: "  hfc.it@yale.edu ",
      })?.rule
    ).toBe("mailbox");
  });

  it("claims ONE address, not the whole DOMAIN the connected mailbox sits on", () => {
    // The mailbox rule is an exact-address match, and this is the test that says
    // so. Widening it to compare domains would be an easy and plausible edit --
    // and on a Maileroo deployment it would move every sibling address on the
    // mailbox's domain onto Graph, inheriting Exchange Online's ~30 msg/min
    // ceiling, which is invisible until a roster-wide campaign takes hours.
    //
    // alice@yale.edu shares the mailbox's domain, is not on the address list,
    // and must still route by DOMAIN.
    expect(
      decideSigningTransport("alice@yale.edu", {
        graphAddresses,
        domains,
        graphMailbox: "hfc.it@yale.edu",
      })
    ).toEqual({ transport: "maileroo", rule: "domain" });
  });

  it("still answers null for an address no rule claims", () => {
    // A pinned address does not make its whole domain signable, and an unlisted
    // domain is still unlisted.
    expect(decideSigningTransport("someone@example.com", { graphAddresses, domains })).toBeNull();
  });

  it("does not let a pinned address rescue its neighbours on an unlisted domain", () => {
    const pinned = new Set(["ok@example.com"]);
    expect(
      decideSigningTransport("ok@example.com", { graphAddresses: pinned, domains })?.transport
    ).toBe("graph");
    expect(
      decideSigningTransport("other@example.com", { graphAddresses: pinned, domains })
    ).toBeNull();
  });
});
