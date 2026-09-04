import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { CalendarOff } from "lucide-react";
import { EmptyState } from "./empty-state";

/**
 * React 19 types `ReactElement["props"]` as `unknown`, so these tests read props
 * through a permissive shape rather than sprinkling casts across every assertion.
 */
type Props = { className?: string; children?: unknown; [key: string]: unknown };

const render = (props: Parameters<typeof EmptyState>[0]) =>
  EmptyState(props) as ReactElement<Props>;

/** The block variant's children, with the conditional nulls dropped. */
function blockChildren(el: ReactElement<Props>): ReactElement<Props>[] {
  const children = el.props.children as (ReactElement<Props> | null)[];
  return children.filter(Boolean) as ReactElement<Props>[];
}

describe("EmptyState", () => {
  describe("inline", () => {
    it("renders a one-line paragraph on the canonical subtle token", () => {
      const el = render({ inline: true, children: "None assigned" });
      expect(el.type).toBe("p");
      expect(el.props.className).toContain("text-sm");
      expect(el.props.className).toContain("text-subtle-foreground");
      expect(el.props.children).toBe("None assigned");
    });

    it("adds no padding or centering, so it sits in a table cell", () => {
      const el = render({ inline: true, children: "None" });
      expect(el.props.className).not.toContain("py-");
      expect(el.props.className).not.toContain("text-center");
    });

    it("merges a caller className for outer spacing", () => {
      const el = render({ inline: true, className: "mt-2", children: "None" });
      expect(el.props.className).toContain("mt-2");
    });
  });

  describe("block", () => {
    it("centers and pads, and puts the title on text-foreground", () => {
      const el = render({ title: "No shifts assigned yet" });
      expect(el.type).toBe("div");
      expect(el.props.className).toContain("text-center");
      expect(el.props.className).toContain("py-10");

      const [title] = blockChildren(el);
      expect(title.type).toBe("p");
      expect(title.props.className).toContain("text-foreground");
      expect(title.props.className).toContain("font-semibold");
      expect(title.props.children).toBe("No shifts assigned yet");
    });

    it("gives the description the subtle token, distinct from the title", () => {
      const el = render({
        title: "No shifts assigned yet",
        description: "Check back after the schedule is published.",
      });
      const [title, description] = blockChildren(el);
      expect(title.props.className).toContain("text-foreground");
      expect(title.props.className).not.toContain("text-subtle-foreground");
      expect(description.props.className).toContain("text-subtle-foreground");
      expect(description.props.children).toBe("Check back after the schedule is published.");
    });

    it("renders the title as a p, never a heading, to protect the document outline", () => {
      const el = render({ title: "Nothing here" });
      for (const child of blockChildren(el)) {
        expect(String(child.type)).not.toMatch(/^h[1-6]$/);
      }
    });

    it("omits the icon, description and action when not supplied", () => {
      expect(blockChildren(render({ title: "Nothing here" }))).toHaveLength(1);
    });

    it("renders an aria-hidden icon when one is supplied", () => {
      const [icon] = blockChildren(render({ icon: CalendarOff, title: "Nothing here" }));
      expect(icon.type).toBe(CalendarOff);
      expect(icon.props["aria-hidden"]).toBe(true);
      expect(icon.props.className).toContain("text-subtle-foreground");
    });

    it("renders an action below the copy", () => {
      const children = blockChildren(render({ title: "Nothing here", action: "ACTION" }));
      const action = children[children.length - 1];
      expect(action.props.className).toContain("mt-4");
      expect(action.props.children).toBe("ACTION");
    });

    it("carries no surface, so it does not double-card inside a Card", () => {
      const el = render({ title: "Nothing here" });
      expect(el.props.className).not.toContain("border");
      expect(el.props.className).not.toContain("bg-");
      expect(el.props.className).not.toContain("rounded");
    });
  });
});
