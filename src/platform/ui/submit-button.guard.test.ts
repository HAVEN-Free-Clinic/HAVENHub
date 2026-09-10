import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

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

/**
 * A submit button may not carry BOTH `formAction` and `name`/`value`.
 *
 * react-dom nulls the submitter as soon as it takes an action off it -- see the
 * submit dispatch in react-dom-client, `null !== domEventName && ((action =
 * domEventName), (submitter = null))` -- so `createFormDataWithSubmitter` never
 * runs and the button's own name/value reaches nothing. Verified against
 * react-dom 19.2.4 with a probe page: a plain submit contributed
 * `["plain","p1"]`, the same button with a `formAction` contributed nothing.
 *
 * It fails silently and looks like a backend bug. `/support/epic`'s Pending tab
 * shipped this pairing: every Cancel posted an empty `requestId`, the service
 * threw EpicNotFoundError, and the user got "not found" on a row plainly on
 * screen. Bind the id instead -- `formAction={cancelAction.bind(null, row.id)}`
 * -- which also gives each row its own pending state.
 */
const BUTTON_WITH_PROPS = /<(?:SubmitButton|ConfirmButton|Button)\b[^>]*>/gs;

function buttonsPairingFormActionWithName(): string[] {
  const files = execSync("git ls-files 'src/**/*.tsx'", { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((f) => existsSync(f));
  const offenders: string[] = [];
  for (const file of files) {
    for (const tag of readFileSync(file, "utf8").matchAll(BUTTON_WITH_PROPS)) {
      const props = tag[0];
      if (/\bformAction=/.test(props) && /\bname=/.test(props)) {
        offenders.push(`${file}: ${props.replace(/\s+/g, " ").slice(0, 90)}`);
      }
    }
  }
  return offenders;
}

describe("a submit button's own name/value", () => {
  it("is never paired with a formAction, which silently discards it", () => {
    expect(buttonsPairingFormActionWithName()).toEqual([]);
  });
});

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
