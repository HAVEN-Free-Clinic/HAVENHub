/**
 * Shared styling for the clinic-date pills in the three "mark availability"
 * forms: the volunteer one on `/schedule`, the attending one inside
 * `attending-portal-section.tsx`, and the director override grid in
 * `builder-availability-view.tsx` on `/schedule/builder`.
 *
 * Why this is a constant rather than a class string in each file: the forms had
 * drifted into near-identical copies, and the bug below was present in all of
 * them. One definition is what stops the next fix landing in only some.
 *
 * The bug it fixes. Each pill used to pick its classes from the SERVER-rendered
 * `checked` value:
 *
 *     const checked = availability.dates.some(...)
 *     <label className={checked ? brandClasses : greyClasses}>
 *       <Checkbox defaultChecked={checked} />
 *
 * The checkbox is uncontrolled, so clicking it toggled the box correctly -- but
 * `checked` is a value computed during the server render and never changes again,
 * so the pill around it kept its original colour for the life of the page. The
 * pill is the large, obvious target (`min-h-11`, the whole date is inside the
 * label); the 16px box is easy to miss. A member clicked a date, saw nothing
 * change, and clicked again -- which silently toggled the date back OFF.
 *
 * PostHog recorded this as friction rather than as an error, because nothing
 * threw: the member-facing pills on `/schedule` took dead clicks by name --
 * "Aug 22, 2026", "Sep 5, 2026", "Dates available" -- and rage clicks on
 * "December 5th" (Aug 28) and "November 14th" (Aug 29).
 *
 * The fix is `has-[:checked]:`, which styles the label from the LIVE state of the
 * checkbox it contains. Every toggle restyles the pill immediately, with no
 * client JavaScript and no change to how the form submits, so every page using
 * these stays a server component.
 *
 * That fix landed for the volunteer and attending forms first, and it worked:
 * date-labelled dead clicks on `/schedule` stop on 2026-08-29 and there has not
 * been a pill rage click since. The builder grid was left on the old pattern and
 * is converted here -- same defect, same markup, simply not yet clicked into a
 * rage by the dozen directors who use it.
 *
 * Note what this does NOT claim. It does not account for the bulk of dead clicks
 * on the scheduling routes. Those land on native `<select>` and `<input>`
 * controls -- 81 of the 120 untitled ones on `/schedule/builder` alone are a
 * `<select>` -- where opening a dropdown or focusing a field mutates no DOM, so
 * the recorder calls the click dead. Those are measurement artifacts, not broken
 * interactions, and no styling change will move them.
 */

/**
 * The live checked and focus styling, shared by every pill size.
 *
 * Split out so a denser variant cannot quietly keep the server-rendered ternary
 * while looking like it opted in -- the geometry is what differs between the
 * forms, and the behaviour is what must not.
 */
const PILL_LIVE_STATE_CLASS = [
  // Live checked state, driven by the contained checkbox rather than by a value
  // fixed at server-render time.
  "has-[:checked]:border-brand has-[:checked]:bg-brand/5",
  "has-[:checked]:text-brand-fg has-[:checked]:font-semibold",
  // Keyboard users get the same ring the other form controls have; the checkbox
  // itself is only 16px, so the affordance belongs on the pill.
  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2",
  "has-[:focus-visible]:outline-brand",
].join(" ");

/** The member-facing pill: one row of dates, so it can afford a 44px target. */
export const AVAILABILITY_PILL_CLASS = [
  "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs",
  "transition-colors whitespace-nowrap min-h-11 cursor-pointer",
  // Resting state.
  "border-border text-muted-foreground hover:border-brand/40",
  PILL_LIVE_STATE_CLASS,
].join(" ");

/**
 * The director override pill on `/schedule/builder`.
 *
 * Same behaviour, tighter geometry: the builder renders every clinic date for
 * every member of the department, so a 44px-tall pill turns one screen into
 * several. The compact size is a deliberate trade against WCAG 2.5.8's 24px
 * floor, which `py-1 text-xs` still clears; it is not a smaller version of the
 * member form by accident.
 */
export const BUILDER_AVAILABILITY_PILL_CLASS = [
  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
  "transition-colors whitespace-nowrap cursor-pointer",
  // Resting state.
  "border-border text-muted-foreground hover:border-border-strong",
  PILL_LIVE_STATE_CLASS,
].join(" ");

/**
 * The same pill with no checkbox in it, for an archived term the builder renders
 * read-only.
 *
 * Here -- and ONLY here -- the server value is the right source for the colour:
 * there is no checkbox to read a live state from, and nothing on the page can
 * change it. It takes a parameter rather than living inline in the component so
 * the one legitimate server-value ternary sits next to the constants it must
 * stay visually consistent with, and so the regression guard over the form files
 * can flag the illegitimate shape without a carve-out.
 */
export function builderReadOnlyPillClass(checked: boolean): string {
  return [
    "rounded-full border px-2.5 py-1 text-xs whitespace-nowrap",
    checked
      ? "border-brand bg-brand/5 text-brand-fg font-semibold"
      : "border-border text-muted-foreground",
  ].join(" ");
}
