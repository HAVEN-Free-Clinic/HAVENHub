import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ListEmpty } from "./list-empty";

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("ListEmpty", () => {
  it("never says 'yet' about a list that is merely filtered", () => {
    // The bug this exists to make impossible. An IT manager filtering
    // /support/all to Priority: High and matching nothing read "No requests
    // yet." on a queue holding hundreds of tickets -- a sentence asserting the
    // opposite of the truth, on the page where a lost ticket history is the
    // most alarming thing it could mean.
    const out = render(<ListEmpty filtered noun="requests" />);
    expect(out).not.toContain("yet");
    expect(out).toContain("No requests match these filters");
  });

  it("tells the user what to do about it", () => {
    // "No X found." is ambiguous between "your filter is too narrow" and "the
    // query failed", which is why people re-ran it or filed a bug instead of
    // clearing a filter.
    const out = render(<ListEmpty filtered noun="people" />);
    expect(out).toContain("Widen your search or clear a filter above.");
  });

  it("says 'yet' only when nothing is filtered", () => {
    const out = render(<ListEmpty filtered={false} noun="requests" />);
    expect(out).toContain("No requests yet");
    expect(out).not.toContain("filters");
  });

  it("shows the true-empty description and action only in the true-empty state", () => {
    // A filtered list must not advertise "create one" or explain what will make
    // rows appear: rows already exist, this search does not reach them.
    const empty = render(
      <ListEmpty filtered={false} noun="scopes" emptyDescription="Scopes bound who a campaign can reach." action={<button>New scope</button>} />,
    );
    expect(empty).toContain("Scopes bound who a campaign can reach.");
    expect(empty).toContain("New scope");

    const filtered = render(
      <ListEmpty filtered noun="scopes" emptyDescription="Scopes bound who a campaign can reach." action={<button>New scope</button>} />,
    );
    expect(filtered).not.toContain("Scopes bound who a campaign can reach.");
    expect(filtered).not.toContain("New scope");
  });
});
