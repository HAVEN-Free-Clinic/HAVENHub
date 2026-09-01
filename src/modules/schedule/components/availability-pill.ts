/**
 * Shared styling for the clinic-date pills in the two "mark your availability"
 * forms: the volunteer one on `/schedule` and the attending one inside
 * `attending-portal-section.tsx`.
 *
 * Why this is a constant rather than a class string in each file: the two forms
 * had drifted into identical copies, and the bug below was present in both. One
 * definition is what stops the next fix landing in only one of them.
 *
 * The bug it fixes. Both pills used to pick their classes from the SERVER-rendered
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
 * PostHog recorded this as friction on the scheduling routes rather than as an
 * error, because nothing threw: 260 dead clicks across `/schedule`,
 * `/schedule/builder`, `/schedule/attendings`, `/schedule/full`,
 * `/schedule/requests` and `/schedule/coverage` in 21 days, with the
 * date-labelled elements among them by name -- "Aug 22, 2026", "Sep 5, 2026",
 * "Dates available" -- and "December 5th" taking rage clicks.
 *
 * The fix is `has-[:checked]:`, which styles the label from the LIVE state of the
 * checkbox it contains. Every toggle restyles the pill immediately, with no
 * client JavaScript and no change to how the form submits, so both pages stay
 * server components.
 *
 * Note this does not claim every dead click on those routes: most carry no
 * element text and are not attributable to this control. It fixes the one
 * defect that is confirmed in the markup and named in the data.
 */
export const AVAILABILITY_PILL_CLASS = [
  "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs",
  "transition-colors whitespace-nowrap min-h-11 cursor-pointer",
  // Resting state.
  "border-border text-muted-foreground hover:border-brand/40",
  // Live checked state, driven by the contained checkbox rather than by a value
  // fixed at server-render time.
  "has-[:checked]:border-brand has-[:checked]:bg-brand/5",
  "has-[:checked]:text-brand-fg has-[:checked]:font-semibold",
  // Keyboard users get the same ring the other form controls have; the checkbox
  // itself is only 16px, so the affordance belongs on the pill.
  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2",
  "has-[:focus-visible]:outline-brand",
].join(" ");
