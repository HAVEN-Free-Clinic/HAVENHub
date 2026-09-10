/**
 * The one assertion here that was RED before the change is "says so when there
 * is nothing to reach the person on": it was written first against
 * `ComplianceNameCell`, which rendered a bare `.join(" · ")` with no fallback,
 * and failed with an empty subline span. The same assertion now runs against
 * the shared cell, so the two compliance rosters cannot go back to a blank line.
 *
 * The link and separator assertions are construction-green -- they pin the
 * contract of a component that did not exist before this commit.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PersonNameCell } from "./person-name-cell";

const person = {
  name: "Ada Lovelace",
  netId: "al123",
  contactEmail: "ada@example.edu",
  phone: "203-555-0100",
};

const render = (node: React.ReactElement) =>
  renderToStaticMarkup(
    <table>
      <tbody>
        <tr>{node}</tr>
      </tbody>
    </table>,
  );

describe("PersonNameCell", () => {
  it("says so when there is nothing to reach the person on", () => {
    // RED before this commit against ComplianceNameCell, which rendered an
    // empty span here. A blank line under a name reads as a broken render, not
    // as "we hold no contact details for this person".
    const out = render(
      <PersonNameCell
        person={{ name: "Ada Lovelace", netId: null, contactEmail: null, phone: null }}
        href="/volunteers/compliance/p1"
      />,
    );
    expect(out).toContain("No contact details on file");
  });

  it("links the name when the viewer can open the profile, and does not when they cannot", () => {
    const linked = render(<PersonNameCell person={person} href="/volunteers/compliance/p1" />);
    expect(linked).toContain('href="/volunteers/compliance/p1"');
    expect(linked).toContain("Ada Lovelace");

    // /volunteers/directory renders to viewers without profile access.
    const plain = render(<PersonNameCell person={person} href={null} />);
    expect(plain).toContain("Ada Lovelace");
    expect(plain).not.toContain("<a ");
  });

  it("joins only the contact details it has, with no stray separator", () => {
    const all = render(<PersonNameCell person={person} />);
    // The phone renders in the app's one format, whatever shape was stored.
    expect(all).toContain("al123 · ada@example.edu · (203) 555-0100");

    const one = render(
      <PersonNameCell person={{ ...person, netId: null, phone: null }} />,
    );
    expect(one).toContain("ada@example.edu");
    expect(one).not.toContain("·");
    expect(one).not.toContain("No contact details on file");
  });
});
