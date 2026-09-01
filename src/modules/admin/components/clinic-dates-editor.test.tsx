/**
 * ClinicDatesEditor's closure controls.
 *
 * The page keys `closures` with `isoDateKey` (see
 * `src/app/(app)/admin/terms/[id]/page.tsx`) while the component looks up
 * each row with its own local `toIsoDate`. Nothing pins the two together, so
 * building this test's `closures` fixture with `isoDateKey` on the same
 * noon-UTC `Date` values passed as `clinicDates` genuinely exercises that the
 * page's keying and the component's lookup agree -- if they ever diverge,
 * every checkbox below would render unchecked and every reason blank.
 *
 * Follows memberships-card.test.tsx's approach: ConfirmButton reads
 * useFormStatus(), which throws outside a real form submit lifecycle in the
 * node test environment, so it is stubbed to render through
 * renderToStaticMarkup.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { isoDateKey } from "@/platform/dates";

vi.mock("@/platform/ui/confirm-button", () => ({
  ConfirmButton: ({ label }: { label: string }) => <button type="submit">{label}</button>,
}));

const { ClinicDatesEditor } = await import("./clinic-dates-editor");

/** Noon-UTC anchored calendar date, matching how the schema stores clinicDate. */
function d(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

const noop = async () => {};

const OPEN_DATE = d(2026, 9, 6);
const CLOSED_DATE = d(2026, 9, 13);
const NULL_REASON_DATE = d(2026, 9, 20);

// Deliberately keyed with isoDateKey, not the component's own toIsoDate, so a
// future divergence between the two would fail these tests.
const CLOSURES = {
  [isoDateKey(CLOSED_DATE)]: { isClosed: true, closedNote: "Thanksgiving" },
  [isoDateKey(NULL_REASON_DATE)]: { isClosed: true, closedNote: null },
};

function render(opts: { editable?: boolean } = {}): string {
  return renderToStaticMarkup(
    <ClinicDatesEditor
      termId="t1"
      clinicDates={[OPEN_DATE, CLOSED_DATE, NULL_REASON_DATE]}
      saturdayIsos={[]}
      updateAction={noop}
      closures={CLOSURES}
      closureAction={noop}
      editable={opts.editable ?? true}
    />,
  );
}

/** Isolates one date's closure <form>...</form> block by its hidden dateKey input. */
function closureFormFor(markup: string, dateKey: string): string {
  const marker = `name="dateKey" value="${dateKey}"`;
  const idx = markup.indexOf(marker);
  if (idx === -1) throw new Error(`no closure form for ${dateKey} found in markup`);
  const formStart = markup.lastIndexOf("<form", idx);
  const formEnd = markup.indexOf("</form>", idx) + "</form>".length;
  return markup.slice(formStart, formEnd);
}

function tag(markup: string, matcher: RegExp): string {
  const match = markup.match(matcher);
  if (!match) throw new Error(`no match for ${matcher} in: ${markup}`);
  return match[0];
}

const checkboxTag = (form: string) => tag(form, /<input[^>]*name="isClosed"[^>]*>/);
const noteTag = (form: string) => tag(form, /<input[^>]*name="closedNote"[^>]*>/);
const saveButtonTag = (form: string) => tag(form, /<button[^>]*>[\s\S]*?<\/button>/);

describe("ClinicDatesEditor", () => {
  it("renders a closed date's checkbox checked and its reason as the input's value", () => {
    const form = closureFormFor(render(), isoDateKey(CLOSED_DATE));
    expect(checkboxTag(form)).toContain("checked");
    expect(noteTag(form)).toContain('value="Thanksgiving"');
  });

  it("renders a date absent from closures unchecked with an empty reason", () => {
    const form = closureFormFor(render(), isoDateKey(OPEN_DATE));
    expect(checkboxTag(form)).not.toContain("checked");
    expect(noteTag(form)).toContain('value=""');
  });

  it("renders a closed date with a null reason checked with an empty reason", () => {
    const form = closureFormFor(render(), isoDateKey(NULL_REASON_DATE));
    expect(checkboxTag(form)).toContain("checked");
    expect(noteTag(form)).toContain('value=""');
  });

  it("disables the closure checkbox, reason input and Save button when not editable", () => {
    // Match the boolean HTML attribute, not the substring: Checkbox/Input/Button
    // all carry Tailwind classes like "disabled:opacity-50" that contain the
    // literal word "disabled" regardless of whether the element is disabled.
    const form = closureFormFor(render({ editable: false }), isoDateKey(CLOSED_DATE));
    expect(checkboxTag(form)).toContain('disabled=""');
    expect(noteTag(form)).toContain('disabled=""');
    expect(saveButtonTag(form)).toContain('disabled=""');
  });

  it("leaves the closure controls enabled when editable", () => {
    const form = closureFormFor(render({ editable: true }), isoDateKey(CLOSED_DATE));
    expect(checkboxTag(form)).not.toContain('disabled=""');
    expect(noteTag(form)).not.toContain('disabled=""');
    expect(saveButtonTag(form)).not.toContain('disabled=""');
  });
});
