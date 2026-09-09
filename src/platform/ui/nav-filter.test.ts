import { describe, it, expect } from "vitest";
import { nextFilterUrl } from "./nav-form";

/**
 * The URL half of useNavFilter. The hook's other half -- reporting the
 * navigation to ListPendingProvider so the table dims -- is the reason the hook
 * exists at all: three filters called router.push directly, and a `?`-only
 * navigation neither remounts a Suspense boundary nor starts the anchor-driven
 * progress bar, so changing a select moved nothing on screen while the server
 * re-queried. On the same pages, clicking a PAGE dimmed the rows, because
 * Pagination reports through that channel.
 */
describe("nextFilterUrl", () => {
  it("drops the page number, which may not exist under the new filter", () => {
    expect(
      nextFilterUrl("/support/all", "status=OPEN&page=4", (p) => p.set("status", "CLOSED")),
    ).toBe("/support/all?status=CLOSED");
  });

  it("keeps every param the viewer did not touch", () => {
    // A filter that rebuilt the query from scratch would silently clear the
    // others -- the same trap FlashReader's strip loop documents.
    expect(
      nextFilterUrl("/support/all", "status=OPEN&priority=HIGH&q=laptop", (p) =>
        p.set("status", "CLOSED"),
      ),
    ).toBe("/support/all?status=CLOSED&priority=HIGH&q=laptop");
  });

  it("navigates to the bare path when the last filter is cleared", () => {
    // Not "/support/all?" with a dangling question mark.
    expect(nextFilterUrl("/support/all", "status=OPEN", (p) => p.delete("status"))).toBe(
      "/support/all",
    );
  });

  it("drops page even when nothing else changes", () => {
    expect(nextFilterUrl("/x", "page=7", () => {})).toBe("/x");
  });
});
