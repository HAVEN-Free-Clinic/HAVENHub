// @vitest-environment jsdom
/**
 * The speed scorer shows the same "Past applications" record as the applicant's
 * detail page, so a scorer weighing a returning applicant does not have to leave
 * the queue to find out they applied before.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SpeedScoreModal } from "./speed-score-modal";
import type { SpeedScoreItem } from "@/modules/recruitment/engine/speed-score-queue";
import type { ReviewApplicationView } from "@/modules/recruitment/services/speed-score";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { container: HTMLDivElement; root: Root } | null = null;

async function mount(history: ReviewApplicationView["history"]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const item: SpeedScoreItem = { applicationId: "a", name: "Ann Lee", typeLabel: "New", myScore: null, myComment: null };
  await act(async () =>
    root.render(
      <SpeedScoreModal
        open
        onClose={() => {}}
        items={[item]}
        onScore={async () => ({})}
        onLoad={async () => ({
          view: { applicationId: "a", name: "Ann Lee", email: "ann@yale.edu", typeLabel: "New", departmentChoices: [], sections: [], history },
        })}
      />,
    ),
  );
  mounted = { container, root };
}

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
  document.body.style.overflow = "";
});

describe("SpeedScoreModal past applications", () => {
  it("shows the summary and each earlier application, opening it in a new tab", async () => {
    await mount({
      summary: "2nd application. Furthest: Applied (Volunteer Spring 2026).",
      rows: [
        {
          key: "live-application-V-SP26-0",
          title: "Volunteer Spring 2026",
          href: "/recruitment/cycles/c1/applicants/p1",
          meta: "Volunteer · SRHD",
          badge: "Applied - Rejected",
        },
      ],
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("Past applications");
    expect(text).toContain("2nd application. Furthest: Applied (Volunteer Spring 2026).");
    expect(text).toContain("Volunteer · SRHD");
    expect(text).toContain("Applied - Rejected");
    const link = document.querySelector<HTMLAnchorElement>('a[href="/recruitment/cycles/c1/applicants/p1"]');
    expect(link?.textContent).toContain("Volunteer Spring 2026");
    // A same-tab link would navigate away and drop the scorer's place in the queue.
    expect(link?.target).toBe("_blank");
  });

  it("says so for a first-time applicant rather than leaving the section out", async () => {
    await mount({ summary: "First application, no earlier record.", rows: [] });
    const text = document.body.textContent ?? "";
    expect(text).toContain("Past applications");
    expect(text).toContain("First application, no earlier record.");
  });
});
