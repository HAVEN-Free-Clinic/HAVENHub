/**
 * Shared styling for the clinic-date pills in the "mark your availability"
 * forms: the volunteer one on `/schedule`, the attending one inside
 * `attending-portal-section.tsx`, and the director override one on
 * `/schedule/builder` (compact variant below).
 *
 * Why this is a constant rather than a class string in each file: the forms
 * had drifted into near-identical copies, and the bug below was present in each.
 * One definition is what stops the next fix landing in only some of them.
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

// Live checked and focus state, shared by every clinic-date pill. `has-[:checked]:`
// styles the label from the LIVE state of the checkbox it contains rather than
// from a value fixed at server-render time. Keyboard users get the same ring the
// other form controls have; the checkbox itself is only 16px, so the affordance
// belongs on the pill.
const PILL_LIVE_STATE_CLASS = [
  "has-[:checked]:border-brand has-[:checked]:bg-brand/5",
  "has-[:checked]:text-brand-fg has-[:checked]:font-semibold",
  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2",
  "has-[:focus-visible]:outline-brand",
].join(" ");

export const AVAILABILITY_PILL_CLASS = [
  "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs",
  "transition-colors whitespace-nowrap min-h-11 cursor-pointer",
  // Resting state.
  "border-border text-muted-foreground hover:border-brand/40",
  PILL_LIVE_STATE_CLASS,
].join(" ");

// Compact variant for the director override grid on `/schedule/builder`, which
// lists every member and stays denser than the volunteer form. Same live-state
// fix, smaller geometry and no min tap height.
export const BUILDER_AVAILABILITY_PILL_CLASS = [
  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
  "transition-colors whitespace-nowrap cursor-pointer",
  // Resting state.
  "border-border text-muted-foreground hover:border-border-strong",
  PILL_LIVE_STATE_CLASS,
].join(" ");
