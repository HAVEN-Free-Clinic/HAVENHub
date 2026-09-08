import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EmailList } from "./email-list";

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("EmailList copy confirmation", () => {
  it("mounts the live region before there is anything to announce", () => {
    // This is the whole point of the region, and the reason it is not wrapped in
    // `{copied && ...}`: a live region inserted into the DOM at the same moment
    // as its content is announced unreliably by most screen readers. It has to
    // already be there, empty, when the copy happens.
    const out = render(<EmailList label="Shift emails" emails={["a@yale.edu", "b@yale.edu"]} />);
    expect(out).toContain('role="status"');
  });

  it("keeps the idle region out of the visual layout", () => {
    // Always present for AT, never a blank gap next to the button.
    const out = render(<EmailList label="Shift emails" emails={["a@yale.edu"]} />);
    expect(out).toMatch(/role="status"[^>]*class="[^"]*sr-only/);
  });

  it("still labels the button itself, so the region is an addition not a replacement", () => {
    // A sighted user reads the button; the region exists for the user who
    // cannot perceive that label change on an already-focused control.
    const out = render(<EmailList label="Shift emails" emails={["a@yale.edu"]} />);
    expect(out).toContain(">Copy<");
  });
});
