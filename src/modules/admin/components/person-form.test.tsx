import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PersonForm } from "./person-form";

// The admin form posts EVERY checkbox on EVERY save (not just the ones the
// admin touched), so `defaultChecked` on the blocker-gate checkbox is the
// only thing standing between a working exemption and a silent revocation:
// if it ever renders unchecked for an exempt person, saving an unrelated
// field (e.g. phone) posts the box unchecked and un-exempts them, hard
// blocking someone who genuinely cannot comply. See
// docs/superpowers/specs/2026-08-12-blocker-gate-person-exemption-design.md.

const noopAction = async () => {};

const BASE_PERSON = {
  name: "Managed Laptop Member",
  netId: "mgd1",
  contactEmail: null,
  phone: null,
  epicId: null,
  yaleAffiliation: null,
  gradYear: null,
  spanishSelfReported: false,
  spanishVerified: false,
  spanishVerifiedAt: null,
  licensedRN: false,
  blockerGateExempt: false,
};

/** Pull the single <input> tag for a given checkbox name out of rendered markup. */
function checkboxTag(markup: string, name: string): string {
  const match = markup.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`));
  if (!match) throw new Error(`no checkbox named ${name} found in markup`);
  return match[0];
}

describe("PersonForm", () => {
  it("renders the blocker-gate checkbox checked when the person is exempt", () => {
    const markup = renderToStaticMarkup(
      <PersonForm action={noopAction} person={{ ...BASE_PERSON, blockerGateExempt: true }} />
    );
    expect(checkboxTag(markup, "blockerGateExempt")).toContain("checked");
  });

  it("renders the blocker-gate checkbox unchecked when the person is not exempt", () => {
    const markup = renderToStaticMarkup(
      <PersonForm action={noopAction} person={{ ...BASE_PERSON, blockerGateExempt: false }} />
    );
    expect(checkboxTag(markup, "blockerGateExempt")).not.toContain("checked");
  });

  it("renders the blocker-gate checkbox unchecked in create mode, with no person at all", () => {
    const markup = renderToStaticMarkup(<PersonForm action={noopAction} />);
    expect(checkboxTag(markup, "blockerGateExempt")).not.toContain("checked");
  });
});
