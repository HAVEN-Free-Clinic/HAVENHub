/**
 * The external-contact directory parser.
 *
 * The setting behind it used to be a blind-copy list: every address on it got
 * every report. It is now a DIRECTORY a reviewer picks from, so a contact needs
 * a display name -- "Dr. Jane Smith" is pickable, "jsmith@yale.edu" is a
 * guess. The format gains `Name <email>` lines while still accepting the bare,
 * comma-separated addresses already sitting in production, so the change needs
 * no data migration.
 */

import { describe, expect, it } from "vitest";
import { parseExternalContacts } from "./external-contacts";

describe("parseExternalContacts", () => {
  it("reads a named contact", () => {
    expect(parseExternalContacts("Dr. Jane Smith <jsmith@yale.edu>")).toEqual([
      { name: "Dr. Jane Smith", email: "jsmith@yale.edu" },
    ]);
  });

  it("reads a bare address, leaving the name null", () => {
    expect(parseExternalContacts("jsmith@yale.edu")).toEqual([
      { name: null, email: "jsmith@yale.edu" },
    ]);
  });

  it("still reads the legacy comma-separated form, so production data survives", () => {
    // This is exactly what the setting holds today. If this breaks, every
    // existing recipient silently disappears from the picker.
    expect(parseExternalContacts("a@yale.edu, b@yale.edu")).toEqual([
      { name: null, email: "a@yale.edu" },
      { name: null, email: "b@yale.edu" },
    ]);
  });

  it("reads one contact per line and mixes both forms", () => {
    const raw = "Dr. Jane Smith <jsmith@yale.edu>\nplain@yale.edu";
    expect(parseExternalContacts(raw)).toEqual([
      { name: "Dr. Jane Smith", email: "jsmith@yale.edu" },
      { name: null, email: "plain@yale.edu" },
    ]);
  });

  it("lowercases addresses and drops duplicates, keeping the first name given", () => {
    const raw = "Dr. Jane Smith <JSmith@Yale.edu>\njsmith@yale.edu";
    expect(parseExternalContacts(raw)).toEqual([
      { name: "Dr. Jane Smith", email: "jsmith@yale.edu" },
    ]);
  });

  it("ignores blank lines and anything without an address", () => {
    expect(parseExternalContacts("\n  \nnot a contact\n")).toEqual([]);
  });

  it("returns nothing for an unset setting", () => {
    expect(parseExternalContacts(null)).toEqual([]);
    expect(parseExternalContacts("")).toEqual([]);
  });
});
