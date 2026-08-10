/**
 * Tests for the shared HistoricalApplicant read layer.
 *
 * Two callers depend on the guarantees below (the /recruitment/history browser
 * and the command palette's entity search), so they are tested here once rather
 * than twice at the call sites:
 *   - the search matches on first name, last name, primary email, a SECONDARY
 *     email, and NetID, case-insensitively;
 *   - named identities always come back ahead of nameless ones, and a nameless
 *     identity can never crowd a named one out of a limited result set (#534);
 *   - a nameless identity is still reachable, and still carries a usable label
 *     (#528).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  findHistoricalApplicants,
  historicalApplicantLabel,
  historicalApplicantWhere,
  looksLikeEmail,
} from "./historical-applicants";

/**
 * Create an imported identity. firstName/lastName default to empty strings
 * because that is what the interest-form import actually wrote: the columns are
 * NOT NULL, so "nameless" is two empty strings and never a null.
 */
async function createHistorical(opts: {
  firstName?: string;
  lastName?: string;
  primaryEmail: string;
  netId?: string;
  otherEmails?: string[];
}) {
  return prisma.historicalApplicant.create({
    data: {
      firstName: opts.firstName ?? "",
      lastName: opts.lastName ?? "",
      primaryEmail: opts.primaryEmail,
      netId: opts.netId ?? null,
      emails: { create: [opts.primaryEmail, ...(opts.otherEmails ?? [])].map((email) => ({ email })) },
    },
  });
}

const search = (term: string, take = 10) => findHistoricalApplicants(historicalApplicantWhere(term), take);

beforeEach(resetDb);

describe("historicalApplicantWhere", () => {
  it("matches everything for an empty or whitespace term", () => {
    expect(historicalApplicantWhere("")).toEqual({});
    expect(historicalApplicantWhere("   ")).toEqual({});
    expect(historicalApplicantWhere(undefined)).toEqual({});
  });

  it("finds an identity by last name, case-insensitively", async () => {
    const a = await createHistorical({ firstName: "Ada", lastName: "Lovelace", primaryEmail: "ada@yale.edu" });
    expect((await search("lovel")).map((r) => r.id)).toEqual([a.id]);
  });

  it("finds an identity by first name", async () => {
    const a = await createHistorical({ firstName: "Ada", lastName: "Lovelace", primaryEmail: "ada@yale.edu" });
    expect((await search("ADA")).map((r) => r.id)).toEqual([a.id]);
  });

  it("finds an identity by NetID", async () => {
    const a = await createHistorical({
      firstName: "Ada",
      lastName: "Lovelace",
      primaryEmail: "ada@yale.edu",
      netId: "al2345",
    });
    expect((await search("al2345")).map((r) => r.id)).toEqual([a.id]);
  });

  // The address a reviewer remembers is often not the one the merge promoted to
  // primary, so the emails relation has to be searched, not just the column.
  it("finds an identity by a secondary email the merge did not promote", async () => {
    const a = await createHistorical({
      firstName: "Ada",
      lastName: "Lovelace",
      primaryEmail: "ada@yale.edu",
      otherEmails: ["ada.lovelace@gmail.com"],
    });
    expect((await search("lovelace@gmail")).map((r) => r.id)).toEqual([a.id]);
  });

  // A name lives in two columns, so no single column contains "Ada Lovelace"
  // and a whole-term `contains` against each one in turn finds nothing. Typing
  // a full name is the most likely thing a searcher does, so it has to work.
  it("finds an identity by full name, which no single column contains", async () => {
    const a = await createHistorical({ firstName: "Ada", lastName: "Lovelace", primaryEmail: "ada@yale.edu" });
    expect((await search("Ada Lovelace")).map((r) => r.id)).toEqual([a.id]);
  });

  it("finds an identity when the words are typed in either order", async () => {
    const a = await createHistorical({ firstName: "Ada", lastName: "Lovelace", primaryEmail: "ada@yale.edu" });
    expect((await search("lovelace ada")).map((r) => r.id)).toEqual([a.id]);
  });

  it("finds an identity from a first name and a NetID together", async () => {
    const a = await createHistorical({
      firstName: "Ada",
      lastName: "Lovelace",
      primaryEmail: "ada@yale.edu",
      netId: "al2345",
    });
    expect((await search("ada al2345")).map((r) => r.id)).toEqual([a.id]);
  });

  it("requires every word to match, so a wrong surname excludes the row", async () => {
    await createHistorical({ firstName: "Ada", lastName: "Lovelace", primaryEmail: "ada@yale.edu" });
    expect(await search("Ada Babbage")).toEqual([]);
  });

  it("ignores extra whitespace between and around the words", async () => {
    const a = await createHistorical({ firstName: "Ada", lastName: "Lovelace", primaryEmail: "ada@yale.edu" });
    expect((await search("  Ada   Lovelace  ")).map((r) => r.id)).toEqual([a.id]);
  });

  it("returns nothing for a term that matches no identifier", async () => {
    await createHistorical({ firstName: "Ada", lastName: "Lovelace", primaryEmail: "ada@yale.edu" });
    expect(await search("babbage")).toEqual([]);
  });
});

describe("findHistoricalApplicants ordering", () => {
  it("sorts named identities by last name, then first name", async () => {
    await createHistorical({ firstName: "Bea", lastName: "Zeta", primaryEmail: "bz@yale.edu" });
    await createHistorical({ firstName: "Cal", lastName: "Alpha", primaryEmail: "ca@yale.edu" });
    await createHistorical({ firstName: "Abe", lastName: "Alpha", primaryEmail: "aa@yale.edu" });
    expect((await search("yale.edu")).map((r) => `${r.firstName} ${r.lastName}`)).toEqual([
      "Abe Alpha",
      "Cal Alpha",
      "Bea Zeta",
    ]);
  });

  // The #534 shape. An empty lastName sorts ahead of every real name, so a
  // single orderBy + take returned nameless rows and nothing else.
  it("never lets nameless identities crowd a named one out of a limited result set", async () => {
    for (let i = 0; i < 5; i++) {
      await createHistorical({ primaryEmail: `nameless${i}@yale.edu` });
    }
    const named = await createHistorical({ firstName: "Ada", lastName: "Lovelace", primaryEmail: "ada@yale.edu" });

    const rows = await search("yale.edu", 3);
    expect(rows).toHaveLength(3);
    expect(rows[0].id).toBe(named.id);
  });

  it("backfills with nameless identities only once the named ones run out", async () => {
    const named = await createHistorical({ firstName: "Ada", lastName: "Lovelace", primaryEmail: "ada@yale.edu" });
    const nameless = await createHistorical({ primaryEmail: "zzz@yale.edu" });

    expect((await search("yale.edu", 10)).map((r) => r.id)).toEqual([named.id, nameless.id]);
  });

  it("keeps a nameless identity findable by its email", async () => {
    const a = await createHistorical({ primaryEmail: "ghost@yale.edu" });
    expect((await search("ghost")).map((r) => r.id)).toEqual([a.id]);
  });

  it("respects the take cap", async () => {
    for (let i = 0; i < 4; i++) {
      await createHistorical({ firstName: "A", lastName: `Name${i}`, primaryEmail: `a${i}@yale.edu` });
    }
    expect(await search("yale.edu", 2)).toHaveLength(2);
  });
});

describe("historicalApplicantLabel", () => {
  it("uses the full name when there is one", () => {
    expect(historicalApplicantLabel({ firstName: "Ada", lastName: "Lovelace", primaryEmail: "ada@yale.edu" })).toBe(
      "Ada Lovelace",
    );
  });

  // A blank name is expected imported data, not a defect: falling through to the
  // email is what keeps the row identifiable and clickable (#528).
  it("falls back to the email when the identity has no name at all", () => {
    expect(historicalApplicantLabel({ firstName: "", lastName: "", primaryEmail: "ghost@yale.edu" })).toBe(
      "ghost@yale.edu",
    );
  });

  it("does not leave a stray space when only one name half is present", () => {
    expect(historicalApplicantLabel({ firstName: "", lastName: "Lovelace", primaryEmail: "x@yale.edu" })).toBe(
      "Lovelace",
    );
  });

  it("falls back to the raw value even when it is not an address", () => {
    expect(historicalApplicantLabel({ firstName: "", lastName: "", primaryEmail: "sourav roy" })).toBe("sourav roy");
  });
});

describe("looksLikeEmail", () => {
  it("accepts an ordinary address", () => {
    expect(looksLikeEmail("ada@yale.edu")).toBe(true);
  });

  // The real junk the import carried through in the email column.
  it.each(["zentner", "sourav roy", "paola.corral&yale.edu", "n/a", "ada@yale"])(
    "rejects %j, which the import found in the email column",
    (value) => {
      expect(looksLikeEmail(value)).toBe(false);
    },
  );
});
