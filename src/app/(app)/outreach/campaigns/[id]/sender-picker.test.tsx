// @vitest-environment jsdom
/**
 * The EMPTY-OPTION state, chiefly.
 *
 * It is not an edge case: it is the default for every delegated sender with
 * nothing issued to them whose campaign's scope carries no identity, which is
 * the state created by removing the sender's own contactEmail as a claim (see
 * sender-identity.ts). Nothing else in the branch would catch a regression in
 * it, because the server-side tests assert an empty option LIST and stop there,
 * and a picker that crashed, or that offered a phantom entry, would still pass
 * every one of them.
 *
 * Bare createRoot + act(), like every other component test in this directory:
 * this repo has no @testing-library/react (see audience-builder.test.tsx).
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SenderPicker, type SenderOption } from "./sender-picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(options: SenderOption[], initial: string | null = null) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<SenderPicker options={options} initial={initial} />);
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function select(): HTMLSelectElement {
  return container.querySelector('select[name="fromEmail"]') as HTMLSelectElement;
}

function optionTexts(): string[] {
  return [...select().options].map((o) => o.textContent ?? "");
}

describe("SenderPicker with no identities available", () => {
  it("renders exactly one option, and it submits as the empty default", () => {
    render([]);
    expect(select()).not.toBeNull();
    expect(optionTexts()).toHaveLength(1);
    // The empty value is what tells updateCampaign "no explicit choice", which
    // it stores as null rather than pinning today's default. A phantom option
    // carrying an address here would be a claim the server would then refuse.
    expect(select().options[0].value).toBe("");
    expect(select().value).toBe("");
  });

  it("tells the sender what to do about it", () => {
    // The picker is the only surface where a sender meets this state. The
    // server's refusal text already says to ask an admin; saying nothing here
    // leaves them looking at a control with one inert entry and no explanation.
    render([]);
    expect(container.textContent).toContain("ask an admin");
  });

  it("does not claim the global sender is what goes out", () => {
    // With no identity the enqueue falls to resolveSenderForTemplate, where a
    // TEMPLATE or CATEGORY rule for the campaign group wins BEFORE the global
    // email.sender setting. Naming the global setting here would be wrong
    // whenever a Campaigns category rule exists, which is the configuration the
    // admin email screen exists to create.
    render([]);
    expect(optionTexts()[0]).not.toContain("clinic's configured sender");
  });

  it("still warns when a stored choice is no longer available", () => {
    // The two states compose: an issued address revoked after the campaign was
    // composed leaves the sender with a stored fromEmail AND an empty list.
    // Without the warning the form would silently re-save as the default.
    render([], "revoked@havenfreeclinic.org");
    expect(container.textContent).toContain("revoked@havenfreeclinic.org");
    expect(container.textContent).toContain("no longer available to you");
    // And the control has fallen back to the default rather than pre-selecting
    // an address the server would refuse.
    expect(select().value).toBe("");
  });
});

describe("SenderPicker with identities available", () => {
  const SCOPE: SenderOption = {
    address: "peds@havenfreeclinic.org",
    displayName: "HAVEN Pediatrics",
    source: "scope",
  };
  const ISSUED: SenderOption = {
    address: "recruitment@havenfreeclinic.org",
    displayName: null,
    source: "issued",
  };

  it("labels the default with the strongest claim, and lists each option once", () => {
    render([SCOPE, ISSUED]);
    const texts = optionTexts();
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain("peds@havenfreeclinic.org");
    expect(texts[0]).toContain("this campaign's scope");
    // [0] is the default row, so the two real options are [1] and [2].
    expect(texts[1]).toContain("peds@havenfreeclinic.org");
    expect(texts[2]).toContain("issued to you");
    // No advice to seek an admin when they already have something to send as.
    expect(container.textContent).not.toContain("ask an admin");
  });

  it("preselects a stored choice that is still available, without warning", () => {
    render([SCOPE, ISSUED], ISSUED.address);
    expect(select().value).toBe(ISSUED.address);
    expect(container.textContent).not.toContain("no longer available to you");
  });
});

/**
 * NO SenderIdentityNotes, which is the owner's second request and the reason
 * this file's fixtures use a yale.edu address at all.
 *
 * yale.edu is the case that USED to produce two stacked warning panels here: it
 * routes to Graph, so the picker rendered both the throughput ceiling and (since
 * it is not the connected mailbox) the Send-As requirement. Both are facts an
 * ADMIN needs while issuing an address or setting one on a scope, where the
 * notes still render. Neither is actionable for a sender, who can only pick from
 * what an admin already approved, so on this screen they were two warnings about
 * a decision already made for them.
 *
 * Asserted BOTH ways on purpose. The text assertions say which words must not
 * come back; the role-count assertion catches a reintroduction that reworded
 * them, which the text ones alone would miss.
 */
describe("SenderPicker does not warn the sender about the transport", () => {
  const YALE: SenderOption = {
    address: "dean@yale.edu",
    displayName: null,
    source: "issued",
  };

  it("renders no alert at all for a Graph-routed identity", () => {
    render([YALE]);
    expect(optionTexts()[0]).toContain("dean@yale.edu");
    expect(container.textContent).not.toContain("Paces out over hours");
    expect(container.textContent).not.toContain("Send-As");
    expect(container.textContent).not.toContain("Microsoft Graph");
    // Every Alert renders role="alert" (error) or role="status" (everything
    // else), so this counts warning boxes without depending on their wording.
    expect(container.querySelectorAll('[role="alert"],[role="status"]')).toHaveLength(0);
  });

  it("still renders the stale-choice warning, and only that one", () => {
    // The picker keeps exactly one Alert, and it is about authorization rather
    // than transport: a choice the sender may no longer use. Removing the notes
    // must not have taken it with them.
    render([YALE], "revoked@havenfreeclinic.org");
    const alerts = container.querySelectorAll('[role="alert"],[role="status"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toContain("no longer available to you");
  });

  it("keeps the empty-state guidance, which is not one of those notes", () => {
    // One line of plain text, no Alert, and the only surface on which a sender
    // meets the no-identities state. It names the two routes to getting one.
    render([]);
    expect(container.textContent).toContain("audience scope");
    expect(container.textContent).toContain("issue one to you");
    expect(container.querySelectorAll('[role="alert"],[role="status"]')).toHaveLength(0);
  });
});
