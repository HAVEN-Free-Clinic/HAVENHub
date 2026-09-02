/**
 * The verified-domain allowlist.
 *
 * Every decision is asserted at BOTH polarities. A test that only checked "a
 * havenfreeclinic.org From is Maileroo-signable" would pass against an
 * implementation that answered "maileroo" for everything, which is exactly the
 * unconditional pin this allowlist replaces.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SENDING_DOMAINS,
  SENDING_DOMAINS,
  domainOf,
  parseSendingDomains,
  signingTransportFor,
} from "./sending-domains";

describe("the default allowlist", () => {
  it("maps each domain to the transport that can actually sign for it", () => {
    // Not the same transport for both: havenfreeclinic.org has
    // include:_spf.maileroo.com, yale.edu does not and its Maileroo entry is
    // disabled, so Graph is the only signer for it today.
    expect(DEFAULT_SENDING_DOMAINS["havenfreeclinic.org"]).toBe("maileroo");
    expect(DEFAULT_SENDING_DOMAINS["yale.edu"]).toBe("graph");
  });

  it("is what the module resolves to when no override is configured", () => {
    expect(SENDING_DOMAINS.get("havenfreeclinic.org")).toBe("maileroo");
    expect(SENDING_DOMAINS.get("yale.edu")).toBe("graph");
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
      expect(map.get("yale.edu")).toBe("graph");
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

  it("can move yale.edu to Maileroo without a code edit, the day it is re-enabled", () => {
    const map = parseSendingDomains("havenfreeclinic.org:maileroo,yale.edu:maileroo");
    expect(map.get("yale.edu")).toBe("maileroo");
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
      expect(map.get("yale.edu"), spec).toBe("graph");
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

  it("answers graph for a Graph-signable From", () => {
    expect(signingTransportFor("hfc.it@yale.edu")).toBe("graph");
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
    expect(signingTransportFor("HFC.IT@Yale.Edu")).toBe("graph");
  });
});
