import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DescriptionList, DetailRow } from "./description-list";

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("DetailRow", () => {
  it("gives the value the ink and the label the small grey", () => {
    // The inversion this exists to end: /incidents/[id] drew the label small and
    // grey over a dark value, and the strike row for the SAME case drew the
    // label dark and bold over a grey value.
    const out = render(<DetailRow label="Setting">Clinic floor</DetailRow>);
    expect(out).toContain('<dt class="text-xs text-subtle-foreground">Setting</dt>');
    expect(out).toContain("text-sm text-foreground");
    expect(out).not.toContain("font-medium");
  });

  it("marks an absent value as absent rather than drawing it as an answer", () => {
    // "(none)" in the value's own ink is indistinguishable from a reporter who
    // typed "(none)". On an incident report that distinction can decide a strike.
    const out = render(<DetailRow label="Setting">{null}</DetailRow>);
    expect(out).toContain("italic text-subtle-foreground");
    expect(out).toContain("Not provided");
  });

  it("treats the React idioms for 'no value' as empty", () => {
    for (const value of [null, undefined, false, ""]) {
      const out = render(<DetailRow label="Setting">{value}</DetailRow>);
      expect(out, `children=${JSON.stringify(value)}`).toContain("Not provided");
    }
  });

  it("keeps a zero, which is a value", () => {
    const out = render(<DetailRow label="Strikes">{0}</DetailRow>);
    expect(out).toContain("<dd class=\"mt-0.5 text-sm text-foreground\">0</dd>");
    expect(out).not.toContain("Not provided");
  });

  it("lets the caller pick the word but not the treatment", () => {
    // An unanswered radio on an incident form is "Not answered"; a profile field
    // nobody has filled is "Not set". Both draw the same way.
    const answered = render(<DetailRow label="Ongoing risk" empty="Not answered" />);
    const unset = render(<DetailRow label="Phone" empty="Not set" />);
    expect(answered).toContain("Not answered");
    expect(unset).toContain("Not set");
    for (const out of [answered, unset]) expect(out).toContain("italic text-subtle-foreground");
  });

  it("honours newlines only where the value is stored free text", () => {
    expect(render(<DetailRow label="Description" wrap>a</DetailRow>)).toContain("whitespace-pre-wrap");
    expect(render(<DetailRow label="Setting">a</DetailRow>)).not.toContain("whitespace-pre-wrap");
  });

  it("spans the full width at every column count, not just two", () => {
    // sm:col-span-2 was the hand-rolled version and is wrong in a 3-column list.
    expect(render(<DetailRow label="Description" wide>a</DetailRow>)).toContain("sm:col-span-full");
  });
});

describe("DescriptionList", () => {
  it("is a real dl", () => {
    const out = render(
      <DescriptionList>
        <DetailRow label="Setting">Clinic floor</DetailRow>
      </DescriptionList>,
    );
    expect(out).toMatch(/^<dl class="[^"]*">/);
    expect(out).toContain("<dt");
    expect(out).toContain("<dd");
  });

  it("stacks at columns=1 without leaving a stray grid-cols class", () => {
    expect(render(<DescriptionList columns={1}>x</DescriptionList>)).not.toContain("grid-cols");
  });
});
