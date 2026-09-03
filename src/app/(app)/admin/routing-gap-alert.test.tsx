// @vitest-environment jsdom
/**
 * The transport-flip warning.
 *
 * Risk 4 of this change -- "an admin about to flip email.transport sees which
 * addresses silently move, and is not blocked from flipping anyway" -- rests
 * entirely on this component. emailRoutingGap decides WHAT moves and is tested
 * against real sender-rule rows in routing-gap.test.ts; everything about whether
 * a human is actually told lives here, and nothing was pinning it.
 *
 * Rendered to HTML and parsed, the same way alert.test.tsx does, because the
 * claims are about what reaches the page rather than about the React tree: that
 * the card appears at all, that it says the right one of two quite different
 * things, and that it contains no control that could stop the flip.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RoutingGapAlert } from "./routing-gap-alert";
import type { EmailRoutingGap } from "@/platform/email/routing-gap";

function render(gap: EmailRoutingGap | null, where: "settings" | "email" = "settings"): string {
  return renderToStaticMarkup(<RoutingGapAlert gap={gap} where={where} />);
}

function text(markup: string): string {
  const host = document.createElement("div");
  host.innerHTML = markup;
  return host.textContent ?? "";
}

/** A gap with two moving addresses and nothing else remarkable. */
const gap = (over: Partial<EmailRoutingGap> = {}): EmailRoutingGap => ({
  transport: "graph",
  entries: [
    { address: "recruitment@yale.edu", usedBy: ["Recruitment"] },
    { address: "shifts@yale.edu", usedBy: ["Shift reminders"] },
  ],
  graphRoutedCount: 1,
  globalSender: { address: "hfc.admin@yale.edu", graphRouted: true },
  ...over,
});

describe("RoutingGapAlert", () => {
  it("renders nothing when the check could not run", () => {
    // emailRoutingGap returns null on a database problem. /admin/settings
    // survives a Neon blip today and a warning card is not worth turning that
    // into a 500.
    expect(render(null)).toBe("");
  });

  it("renders nothing under the log transport, where no mail is delivered at all", () => {
    // Otherwise this fires on every developer's machine, which is how a warning
    // box teaches people to stop reading warning boxes.
    expect(render(gap({ transport: "log" }))).toBe("");
  });

  it("renders nothing when nothing moves", () => {
    // The all-clear is silent on purpose. A page that congratulates itself on
    // every load trains people to skip its boxes, including this one.
    const markup = render(
      gap({
        entries: [],
        globalSender: { address: "hfc.admin@yale.edu", graphRouted: true },
      })
    );
    expect(markup).toBe("");
  });

  it("still renders when only the GLOBAL DEFAULT moves", () => {
    // No sender rule is affected, but every category without one sends as this
    // address -- authentication included, which is magic-link logins. Silence
    // here would be the worst possible false all-clear.
    const markup = render(
      gap({
        entries: [],
        globalSender: { address: "noreply@yale.edu", graphRouted: false },
      })
    );
    expect(markup).not.toBe("");
    expect(text(markup)).toContain("noreply@yale.edu");
    expect(text(markup)).toContain("magic-link logins");
  });

  it("omits the global-default paragraph when that address stays put", () => {
    // The other polarity: without it, a component that always printed the
    // paragraph would pass the case above.
    expect(text(render(gap()))).not.toContain("moves too");
  });

  it("warns in the FUTURE tense under graph, which is production's current state", () => {
    const t = text(render(gap({ transport: "graph" })));
    expect(t).toContain("would move this mail off Graph");
    expect(t).toContain("recruitment@yale.edu");
    expect(t).toContain("shifts@yale.edu");
    // And names the lever that keeps an address on Graph.
    expect(t).toContain("GRAPH_SENDER_ADDRESSES");
  });

  it("reports in the PAST tense under maileroo, where the move already happened", () => {
    const t = text(render(gap({ transport: "maileroo" })));
    expect(t).toContain("going out through Maileroo");
    expect(t).not.toContain("would move this mail off Graph");
  });

  it("names which rules send as each moving address", () => {
    // One mailbox commonly serves several categories, and the count of rules is
    // what tells an admin how much moves.
    const t = text(
      render(
        gap({
          entries: [
            { address: "clinic@yale.edu", usedBy: ["Campaigns", "Incident Reports"] },
          ],
        })
      )
    );
    expect(t).toContain("clinic@yale.edu");
    expect(t).toContain("Campaigns, Incident Reports");
  });

  it("agrees in number when reporting what stays on Graph", () => {
    expect(text(render(gap({ graphRoutedCount: 1 })))).toContain("1 other send-from address stays");
    expect(text(render(gap({ graphRoutedCount: 3 })))).toContain(
      "3 other send-from addresses stay"
    );
    // And says nothing at all when none do, rather than "0 other addresses stay".
    expect(text(render(gap({ graphRoutedCount: 0 })))).not.toContain("other send-from");
  });

  it("points at the other surface, and flips which one with `where`", () => {
    const settings = render(gap(), "settings");
    expect(settings).toContain('href="/admin/email"');
    expect(text(settings)).toContain("Review the send-from addresses");

    const email = render(gap(), "email");
    expect(email).toContain('href="/admin/settings"');
    expect(text(email)).toContain("Change the email transport");
  });

  it("cannot block the flip, because it renders no control at all", () => {
    // The deliberate design choice, asserted rather than trusted. An operator is
    // allowed to decide that all of these should move; what they must not do is
    // decide it by accident. A `validate` hook on the setting would have refused
    // instead of warned, which is the wrong shape for a consequence that may be
    // exactly what was intended.
    const markup = render(gap());
    expect(markup).not.toMatch(/<button/i);
    expect(markup).not.toMatch(/<input/i);
    expect(markup).not.toMatch(/<form/i);
    expect(markup).not.toMatch(/disabled/i);
  });

  it("announces itself to a screen reader rather than relying on colour", () => {
    expect(render(gap())).toContain('role="status"');
  });
});
