/**
 * Recognise dead clicks that land on a native form control, so they stay out of
 * the dead-click signal.
 *
 * posthog-js flags a click as `$dead_click` when nothing observable follows it
 * within ~3s: no navigation, no scroll, and -- the branch that fires here -- no
 * DOM mutation. Opening a native `<select>` dropdown, or focusing an `<input>`
 * or `<textarea>`, is a working, intended interaction that mutates no DOM: the
 * dropdown is drawn by the OS and the caret is not a node change. So the
 * recorder calls these clicks dead even though the control did exactly what the
 * member asked.
 *
 * This is the bulk of the recurring dead-click volume on the scheduling routes.
 * A member opening "Request a change" clicks the swap-partner `<select>` and the
 * note `<input>`, both native controls, and each click is recorded as dead
 * before the eventual `change` and submit. The pattern is not specific to
 * schedule -- it is inherent to how the heuristic reads native controls -- so
 * the filter is by control type, not by route.
 *
 * Deliberately narrow, matching the other filters in this directory: a broad
 * "drop dead clicks on any form element" would eat real signal. In particular it
 * does NOT filter:
 *
 *  - `<label>` and `<input type=checkbox|radio>`. A toggle that DOES restyle the
 *    page mutates the DOM and is not dead; a toggle that does NOT restyle is the
 *    exact defect the availability pills had (#687), and its dead/rage clicks are
 *    how that regression would surface again. Keeping them is the point.
 *  - `<button>`, `<input type=submit>`, and links. A dead click there means an
 *    action did not fire -- real friction worth seeing.
 *
 * Only controls whose click inherently causes no synchronous DOM change are
 * dropped: `<select>`, `<textarea>`, and text-entry `<input>` types.
 */

/**
 * `<input>` types whose click focuses the field and mutates nothing. The empty
 * string covers an `<input>` with no `type` attribute, which the browser treats
 * as `text`. Toggles (checkbox, radio), buttons (button, submit, reset, image),
 * and the file picker are intentionally absent -- their clicks can change the
 * page or fire an action, so a dead click on them is real.
 */
const NATIVE_TEXT_INPUT_TYPES = new Set([
  "",
  "text",
  "email",
  "search",
  "url",
  "tel",
  "password",
  "number",
]);

type ClickTarget = { tag: string; type: string };

/**
 * Pull the clicked element -- the first segment of the autocapture
 * `$elements_chain`, before the first ";" -- as a `{ tag, type }` pair. The
 * chain is the serialised element form posthog-js carries on the event that
 * `before_send` receives.
 */
function clickTarget(properties: Record<string, unknown> | undefined): ClickTarget | null {
  const chain = properties?.$elements_chain;
  if (typeof chain !== "string" || chain.length === 0) return null;

  const first = chain.split(";")[0];
  const tag = first.match(/^([a-z0-9-]+)/i)?.[1]?.toLowerCase();
  if (!tag) return null;

  const type = first.match(/attr__type="([^"]*)"/)?.[1]?.toLowerCase() ?? "";
  return { tag, type };
}

/** The slice of posthog-js's `CaptureResult` this filter reads. */
type CapturedEvent = {
  event?: string;
  properties?: Record<string, unknown>;
};

/**
 * True when a posthog-js event is a `$dead_click` on a native `<select>`,
 * `<textarea>`, or text-entry `<input>`. Used as a drop condition in
 * `before_send`.
 */
export function isNativeControlDeadClickEvent(event: CapturedEvent | null): boolean {
  if (!event || event.event !== "$dead_click") return false;
  const target = clickTarget(event.properties);
  if (!target) return false;
  if (target.tag === "select" || target.tag === "textarea") return true;
  if (target.tag === "input") return NATIVE_TEXT_INPUT_TYPES.has(target.type);
  return false;
}
