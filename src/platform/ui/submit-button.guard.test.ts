import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";

/**
 * Two surfaces kept drifting away from SubmitButton, and both drifts were
 * invisible because the surrounding file was already doing it right.
 *
 * 1. Bare `<Button type="submit">` inside a `<form action={serverAction}>`.
 *    React form actions do NOT block a second submit: startHostTransition
 *    dispatches a fresh transition per click with no in-flight guard, so the
 *    control stays live and the action runs twice. On the incident detail page
 *    that fired reviewReportAction twice; on /admin/email it queued a second
 *    real test email through Microsoft Graph. Both files already rendered
 *    SubmitButton for their OTHER submits, so the inconsistency was one
 *    scroll apart.
 * 2. A second, local SubmitButton under outreach/campaigns/[id] that omitted
 *    the Spinner and dropped rest props, so the same feature showed two
 *    different pending treatments depending on which page you were on.
 *
 * Deliberately file-scoped rather than repo-wide. Around 70 other
 * `<Button type="submit">` sites remain in src/, most of them GET filter and
 * nav forms (src/platform/ui/filter-bar.tsx, the schedule builder and
 * attending toolbars) that submit no server action and so have no pending
 * state to show. A repo-wide rule would need an allowlist longer than the
 * rule, and is its own project.
 */
const NO_BARE_SUBMIT = [
  "src/app/(app)/incidents/[id]/page.tsx",
  "src/app/(app)/admin/email/page.tsx",
];

describe("server-action submits use the SubmitButton primitive", () => {
  for (const file of NO_BARE_SUBMIT) {
    it(`${file} has no bare <Button type="submit">`, () => {
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).not.toContain('<Button type="submit"');
    });
  }

  it("has no second SubmitButton implementation under outreach campaigns", () => {
    expect(existsSync("src/app/(app)/outreach/campaigns/[id]/submit-button.tsx")).toBe(false);
  });

  it("routes every outreach campaign submit at the platform primitive", () => {
    const importers = [
      "src/app/(app)/outreach/campaigns/[id]/compose-form.tsx",
      "src/app/(app)/outreach/campaigns/[id]/review-actions.tsx",
      "src/app/(app)/outreach/campaigns/[id]/timing-actions.tsx",
      "src/app/(app)/outreach/campaigns/[id]/recipient-preview.tsx",
    ];
    for (const file of importers) {
      expect(readFileSync(file, "utf8")).toContain(
        'import { SubmitButton } from "@/platform/ui/submit-button";',
      );
    }
  });
});
