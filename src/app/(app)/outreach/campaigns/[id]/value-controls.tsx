"use client";

/**
 * Value controls for the date-kind and count-kind audience conditions.
 *
 * Everything here exists to emit ONE OF THREE SHAPES, because those are the
 * only three `dateBoundaryFor` and `countWhere` (operators.ts) know how to
 * parse:
 *
 *   - a bare calendar day, "YYYY-MM-DD"        (before/after/onOrBefore/onOrAfter)
 *   - a two-element array of those             (between)
 *   - a whole, non-negative number as a string (withinNextDays/withinLastDays,
 *                                               and every count comparison)
 *
 * Anything else compiles to MATCH_NOBODY. As a positive fragment that is safe
 * (it never widens a send list) but silent: the campaign goes to nobody and the
 * builder looks fine. Inside a NONE group it is the opposite of safe, because
 * compileGroup renders NONE as `NOT { OR: fragments }` and a leaf that is
 * always false excludes nobody, so the group quietly stops excluding anything.
 * Either way the sender cannot see it. So the controls here are narrow on
 * purpose, and where the compiler would fail quietly they say so out loud.
 *
 * Every state that compiles to MATCH_NOBODY carries a note saying so, whether
 * the sender typed it or it arrived in the stored audience:
 *   - no value entered yet                  (much the most common)
 *   - a stored day that does not exist      ("2026-02-30")
 *   - a stored number that is not a whole   ("-5", "1.5", "three")
 *   - a range whose end precedes its start
 *   - a range holding more than two values  (asArray rejects it)
 *
 * `value-controls.test.tsx` pins that as a biconditional over a table of stored
 * values: the row says "matches nobody" exactly when the compiler returns the
 * sentinel for the same value. Saying it when the compiler does NOT is its own
 * bug, so a note must never be added on a hunch.
 *
 * Separately, text the sender types that is not a whole number is refused
 * outright and never reaches the audience; see WholeNumber for that one, which
 * is not a match-nobody state because the stored value is left alone.
 *
 * ConditionRow keeps its own controls for every other field kind; this
 * component returns null for them rather than trying to be the one value
 * control for everything.
 */

import { useEffect, useId, useState, type ReactNode } from "react";
import type { PersonFieldKind } from "@/platform/email/audience/person-fields";
import type { AudienceCondition, ConditionOp } from "@/platform/email/audience/types";
import { isCalendarDay } from "@/platform/email/audience/zoned-day";
import { Input } from "@/platform/ui/input";

/** The four absolute-boundary date operators; each takes exactly one day. */
const SINGLE_DATE_OPS = new Set<ConditionOp>(["before", "after", "onOrBefore", "onOrAfter"]);

/** The two `now`-anchored window operators; each takes a whole number of days. */
const WINDOW_OPS = new Set<ConditionOp>(["withinNextDays", "withinLastDays"]);

/** The same shape operators.ts accepts: whole and non-negative, nothing else. */
const WHOLE_NUMBER_RE = /^\d+$/;

const WHOLE_NUMBER_MESSAGE = "Enter a whole number of days, zero or more.";
const WHOLE_COUNT_MESSAGE = "Enter a whole number, zero or more.";

/**
 * A form id that deliberately matches no form, which detaches every control
 * carrying it from constraint validation.
 *
 * The bug: the campaign editor keeps all three tab panels MOUNTED and toggles
 * them with the `hidden` attribute (see the comment at page.tsx's EditorTabs),
 * so an audience control lives inside the compose form even while the Compose
 * or Review tab is showing. `display: none` does not bar an element from
 * constraint validation, so a `-5` left in a number box (rangeUnderflow) or a
 * half-typed date (badInput) made the whole form invalid. The browser then
 * tries to focus the offending control, cannot, logs "An invalid form control
 * with name='' is not focusable", and ABORTS the submission with nothing on
 * screen. The sender clicks Save and believes the campaign saved.
 *
 * Why detaching is the principled fix rather than a workaround: none of these
 * inputs carries a `name`, so none of them contributes anything to the
 * submission. The builder submits exactly one field, the serialised JSON hidden
 * input at the bottom of audience-builder.tsx. These controls feed that JSON
 * through React state, never through form data, so they have no business in the
 * form's validity at all. Per the HTML standard's form-owner rules, a listed
 * element with a `form` attribute naming no form element has a null form owner:
 * it drops out of `form.elements` and out of `form.checkValidity()`. It stays a
 * DOM descendant, so the `input`/`change` events useFormDirty listens for on the
 * form element still bubble to it and the unsaved-changes guard is unaffected.
 *
 * The alternative considered was moving the whole Audience panel out of the
 * form's DOM subtree and re-associating the hidden input with `form=`, the way
 * TimingActions does for sendOncePerPerson. Rejected: it forces the panel out
 * of its position between Compose and the Save footer, and it moves the builder
 * out of the subtree useFormDirty watches, so every audience edit would stop
 * marking the draft dirty and ReviewActions would re-enable Send on an unsaved
 * audience. That is a worse failure than the one being fixed. This constant
 * fixes the scope editor at the same time, which the restructure would not.
 *
 * Two invariants this depends on, neither of which any test can catch:
 *
 * 1. Do not add a `name` to any control in this file without removing this
 *    first. A named control here would silently stop submitting.
 * 2. NOTHING ANYWHERE IN THE APP MAY TAKE THIS STRING AS A FORM `id`. A form
 *    with this id makes every control below its form-associated child again,
 *    which reinstates the Save bug in full with no test failure and nothing on
 *    screen: the tests here assert `input.form === null` in documents that
 *    contain no such form, so they would keep passing. The value is
 *    deliberately long and specific so that a collision can only be
 *    deliberate, and it is a module constant so a search for the literal finds
 *    every use.
 */
const NO_FORM_OWNER = "audience-value-control-has-no-form-owner";

type Props = {
  kind: PersonFieldKind;
  op: ConditionOp;
  value: AudienceCondition["value"];
  onChange: (value: AudienceCondition["value"]) => void;
  /** e.g. "Eastern (New York)". Built by zoneLabel() from @/platform/dates. */
  zoneLabel: string;
};

function asSingle(value: AudienceCondition["value"]): string {
  return typeof value === "string" ? value : "";
}

/**
 * The values a range condition actually presents to the compiler.
 *
 * Mirrors `asArray` in operators.ts, which DROPS empty strings and only then
 * applies the `pair.length !== 2` gate. That order matters and is easy to get
 * wrong: `["a","b",""]` and `["","a","b"]` both compile as the range a..b, so a
 * control that judged "is this a usable pair" by array length would put a false
 * match-nobody warning on two conditions that are quietly working. Length is
 * not the compiler's test; the count of non-empty values is.
 */
function usedValues(value: AudienceCondition["value"]): string[] {
  if (typeof value === "string") {
    const one = value.trim();
    return one === "" ? [] : [one];
  }
  const list = Array.isArray(value) ? value : [];
  return list.map((v) => (v ?? "").trim()).filter((v) => v !== "");
}

/**
 * The two endpoints of a range, trimmed, as the two boxes should show them.
 *
 * A bare string is accepted because a Part A audience can hold one under
 * `between`: the pre-fix `valueForOp` treated `between` as single-valued, so
 * switching `before` -> `between` left "2026-03-18" in place. Rendering two
 * blank boxes over a stored value would hide it while it re-serialised
 * unchanged, which is the display-versus-stored divergence this file exists to
 * prevent. DateRange also writes the normalised pair back up on mount.
 *
 * A well-formed two-element array keeps its POSITIONS, so a sender who filled
 * in only the end date sees it in the end box. Any other shape falls back to
 * the compiler's own reading (`usedValues`), because once the array is off-shape
 * position is no longer what the compiler goes by, and showing the first two
 * slots would put "" in a box while a real value further along was doing the
 * filtering.
 *
 * Trimming matches startOfDay/startOfNextDay, which both `.trim()` before
 * validating: a stored " 2026-03-20" compiles to a real boundary and matches
 * people, so the control must neither hide it nor call it impossible.
 */
function asPair(value: AudienceCondition["value"]): [string, string] {
  if (Array.isArray(value) && value.length === 2) {
    return [(value[0] ?? "").trim(), (value[1] ?? "").trim()];
  }
  const used = usedValues(value);
  return [used[0] ?? "", used[1] ?? ""];
}

/**
 * True when a range holds MORE than the two values the compiler accepts.
 *
 * Fewer than two needs no note of its own: `asPair` always leaves at least one
 * box blank in that case, and the empty-endpoint note already covers it.
 */
function hasTooManyValues(value: AudienceCondition["value"]): boolean {
  return usedValues(value).length > 2;
}

export function ValueControl({ kind, op, value, onChange, zoneLabel }: Props) {
  if (kind === "date") {
    if (SINGLE_DATE_OPS.has(op)) {
      return <SingleDate value={value} onChange={onChange} zoneLabel={zoneLabel} />;
    }
    if (op === "between") {
      return <DateRange value={value} onChange={onChange} zoneLabel={zoneLabel} />;
    }
    if (WINDOW_OPS.has(op)) {
      return (
        <WholeNumber
          value={value}
          onChange={onChange}
          ariaLabel="Days"
          suffix="days"
          message={WHOLE_NUMBER_MESSAGE}
        />
      );
    }
    // isEmpty / isNotEmpty take no value at all.
    //
    // A date field carrying an operator its kind does not declare (only
    // reachable from a hand-edited stored audience) also lands here and renders
    // nothing, where the pre-B3 text input at least showed the stored value.
    // Left as-is deliberately: that condition already compiles to MATCH_NOBODY
    // at personFieldWhere's operator gate whatever is typed into it, so a box
    // wired to a value nothing will read invites edits that cannot take effect.
    // It sits inside the class deferred in writing at person-fields.ts.
    return null;
  }

  if (kind === "count") {
    if (op === "between") return <CountRange value={value} onChange={onChange} />;
    return (
      <WholeNumber value={value} onChange={onChange} ariaLabel="Value" message={WHOLE_COUNT_MESSAGE} />
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * One line of guidance under a control, carrying an id so the input can point
 * at it with aria-describedby (the convention Field in platform/ui/input.tsx
 * already follows). A screen reader reaching the box otherwise hears none of
 * the four match-nobody warnings.
 */
function Note({
  id,
  tone,
  children,
}: {
  id: string;
  tone: "info" | "critical";
  children: ReactNode;
}) {
  const className =
    tone === "critical" ? "text-xs text-critical-foreground" : "text-xs text-subtle-foreground";
  return (
    <span id={id} className={className}>
      {children}
    </span>
  );
}

/** Joins the ids of the notes that are actually rendered, or undefined. */
function describedBy(...ids: (string | false | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => typeof id === "string" && id !== "");
  return present.length > 0 ? present.join(" ") : undefined;
}

/** Shared tail, so all four match-nobody states read as one family. */
const MATCHES_NOBODY = "so this condition matches nobody";

// ---------------------------------------------------------------------------
// Absolute dates
// ---------------------------------------------------------------------------

/**
 * The clinic zone note.
 *
 * Not decoration. Part A resolves a calendar day against the clinic's
 * configured display zone (see dateWhere), so "on or before March 20" means the
 * whole of the local 20th. A sender in another zone picking a day from a native
 * date picker has no way to know that from the control alone, and the
 * difference is a whole day of recipients at the boundary.
 */
function ZoneNote({ id, zoneLabel }: { id: string; zoneLabel: string }) {
  return (
    <Note id={id} tone="info">
      Dates are read in {zoneLabel}
    </Note>
  );
}

function SingleDate({
  value,
  onChange,
  zoneLabel,
}: {
  value: AudienceCondition["value"];
  onChange: (value: AudienceCondition["value"]) => void;
  zoneLabel: string;
}) {
  const base = useId();
  const zoneId = `${base}-zone`;
  const impossibleId = `${base}-impossible`;
  const emptyId = `${base}-empty`;

  const day = asSingle(value).trim();
  const empty = day === "";
  // A native date input cannot produce "2026-02-30", but a stored audience can
  // (audienceJson is schema-less), and the browser renders such a value as an
  // EMPTY box. Without this note the sender sees a blank control, no reason,
  // and a campaign that matches nobody. See isCalendarDay in zoned-day.ts.
  const impossible = !empty && !isCalendarDay(day);

  return (
    <div className="flex flex-col gap-1">
      <Input
        aria-label="Date"
        type="date"
        form={NO_FORM_OWNER}
        value={day}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={impossible || undefined}
        aria-describedby={describedBy(zoneId, impossible && impossibleId, empty && emptyId)}
        className="w-auto"
      />
      <ZoneNote id={zoneId} zoneLabel={zoneLabel} />
      {impossible && (
        <Note id={impossibleId} tone="critical">
          {day} is not a real date, {MATCHES_NOBODY}.
        </Note>
      )}
      {empty && (
        <Note id={emptyId} tone="critical">
          No date chosen yet, {MATCHES_NOBODY}.
        </Note>
      )}
    </div>
  );
}

function DateRange({
  value,
  onChange,
  zoneLabel,
}: {
  value: AudienceCondition["value"];
  onChange: (value: AudienceCondition["value"]) => void;
  zoneLabel: string;
}) {
  const base = useId();
  const zoneId = `${base}-zone`;
  const emptyId = `${base}-empty`;
  const reversedId = `${base}-reversed`;
  const tooManyId = `${base}-too-many`;
  const impossibleId = (index: 0 | 1) => `${base}-impossible-${index}`;

  const [from, to] = asPair(value);
  // A third value is not truncated silently: dropping data the sender did not
  // ask to drop is exactly the display-versus-stored divergence this file
  // exists to prevent, and the compiler answers MATCH_NOBODY for it. Say so and
  // let the sender re-pick; editing either box then writes a clean pair.
  const tooMany = hasTooManyValues(value);
  const valueCount = usedValues(value).length;

  // A legacy bare string under `between` is shown in the start box by asPair;
  // write the normalised pair back up so the STORED audience matches what is on
  // screen rather than re-serialising the old shape untouched. Guarded on the
  // value still being a string, so this converges after one write: `onChange`
  // is a fresh closure on every parent render and is in the deps, but once the
  // value is an array this does nothing.
  const strayString = typeof value === "string";
  useEffect(() => {
    if (strayString) onChange([from, to]);
  }, [strayString, from, to, onChange]);

  const impossible: (0 | 1)[] = ([0, 1] as const).filter((i) => {
    const day = i === 0 ? from : to;
    return day !== "" && !isCalendarDay(day);
  });
  const empty = from === "" || to === "";
  // The builder can produce a reversed range with two clicks, and Part A now
  // compiles it to the match-nobody sentinel rather than to an empty gte/lt
  // pair (see the `between` branch in operators.ts). Safe, but invisible unless
  // the control says so. Lexicographic comparison is numeric order for two
  // "YYYY-MM-DD" strings of equal length, which isCalendarDay has guaranteed.
  const reversed = !empty && impossible.length === 0 && from > to;

  const notes = describedBy(
    zoneId,
    empty && emptyId,
    reversed && reversedId,
    tooMany && tooManyId,
    ...impossible.map(impossibleId),
  );

  function set(index: 0 | 1, day: string) {
    const next: [string, string] = [from, to];
    next[index] = day;
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          aria-label="Start date"
          type="date"
          form={NO_FORM_OWNER}
          value={from}
          onChange={(e) => set(0, e.target.value)}
          aria-invalid={impossible.includes(0) || reversed || undefined}
          aria-describedby={notes}
          className="w-auto"
        />
        <span className="text-sm text-foreground-soft">and</span>
        <Input
          aria-label="End date"
          type="date"
          form={NO_FORM_OWNER}
          value={to}
          onChange={(e) => set(1, e.target.value)}
          aria-invalid={impossible.includes(1) || reversed || undefined}
          aria-describedby={notes}
          className="w-auto"
        />
      </div>
      <ZoneNote id={zoneId} zoneLabel={zoneLabel} />
      {impossible.map((i) => (
        <Note key={i} id={impossibleId(i)} tone="critical">
          {i === 0 ? from : to} is not a real date, {MATCHES_NOBODY}.
        </Note>
      ))}
      {empty && (
        <Note id={emptyId} tone="critical">
          Both dates are needed, {MATCHES_NOBODY}.
        </Note>
      )}
      {reversed && (
        <Note id={reversedId} tone="critical">
          This range ends before it starts, {MATCHES_NOBODY}.
        </Note>
      )}
      {tooMany && (
        <Note id={tooManyId} tone="critical">
          This range was saved with {valueCount} values instead of two,{" "}
          {MATCHES_NOBODY}. Re-pick both dates.
        </Note>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Whole numbers: relative windows and count comparisons
// ---------------------------------------------------------------------------

/**
 * A whole, non-negative number, with any rejected text kept on screen.
 *
 * Three rules, all about not lying to the sender:
 *
 * 1. Text that is not a whole number NEVER reaches onChange, so the stored
 *    value is left exactly as it was. `min`/`step` are advisory (a browser puts
 *    "-5" and "1.5" in the value and only objects at form-validation time), and
 *    operators.ts would compile either to match-nobody.
 *
 *    It deliberately does NOT clear the stored value either. "" and "-5"
 *    compile identically, so overwriting a stored "30" buys nothing at compile
 *    time while destroying the author's work over a stray minus key. And the
 *    directions are not symmetric: a stale-but-valid "30" narrows, whereas both
 *    "" and "-5" widen a NONE group to every Person, because an always-false
 *    leaf excludes nobody. Keeping the last good value is the narrow direction.
 *
 * 2. Because of rule 1 the box can show "-5" while "30" is what is stored, so
 *    the note says which one is live rather than leaving the sender to guess.
 *
 * 3. An EMPTIED box is not a rejected entry. It is a deliberate state, it must
 *    reach the audience (or a stored number could never be removed), and it is
 *    itself a match-nobody state, so it gets a note of its own.
 *
 * The typed text lives in local state, since it is exactly the text the parent
 * was not told about. `echo` records what this control last handed up, so a
 * value arriving from OUTSIDE (an operator change, or React reconciling a
 * different condition into this position, since GroupEditor keys children by
 * index) still replaces the box contents, while a rejected keystroke does not.
 */
function WholeNumber({
  value,
  onChange,
  ariaLabel,
  suffix,
  message,
  rangeNoteId,
}: {
  value: AudienceCondition["value"];
  onChange: (value: AudienceCondition["value"]) => void;
  ariaLabel: string;
  suffix?: string;
  message: string;
  /**
   * A note owned by the PARENT that also describes this box, and whose presence
   * means the surrounding range is itself unusable. CountRange's reversed-range
   * and over-long warnings belong to the pair rather than to either endpoint,
   * and without this they were rendered pointing at nothing: a screen reader
   * heard the equivalent warning on a reversed DATE range and not on a count
   * one, because DateRange owns both of its inputs and can wire them itself.
   */
  rangeNoteId?: string;
}) {
  const base = useId();
  const rejectedId = `${base}-rejected`;
  const emptyId = `${base}-empty`;
  const storedInvalidId = `${base}-stored-invalid`;

  const stored = asSingle(value).trim();
  const [text, setText] = useState(stored);
  const [echo, setEcho] = useState(stored);

  if (stored !== echo) {
    setEcho(stored);
    setText(stored);
  }

  const typed = text.trim();
  const empty = stored === "";
  // A STORED value that is not a whole number. countWhere and WINDOW_RE both
  // gate on ^\d+$, so this compiles to MATCH_NOBODY exactly like an empty one,
  // and it needs the same note. It used to fall into the `rejected` branch
  // below and produce "your entry was not applied; this condition still uses
  // abc", which is wrong twice over: nothing was entered, and `abc` is not
  // filtering anything. Reachable from real saved data, since date and count
  // fields used a free-text input before these controls existed.
  const storedInvalid = !empty && !WHOLE_NUMBER_RE.test(stored);
  // Text the sender just typed and this control refused, as distinct from text
  // that arrived in the stored audience. They are only distinguishable by the
  // text differing from what is stored, because a refused keystroke is exactly
  // the case where the two diverge.
  const rejected = typed !== stored && typed !== "" && !WHOLE_NUMBER_RE.test(typed);
  // Whether the STORED value is doing any filtering at all. The rejection note
  // may only claim a value is "still in force" when this is true.
  const storedUsable = !empty && !storedInvalid;

  function handle(next: string) {
    setText(next);
    const candidate = next.trim();
    // Rule 1: a rejected entry stops here. Not propagated, and not cleared.
    if (candidate !== "" && !WHOLE_NUMBER_RE.test(candidate)) return;
    setEcho(candidate);
    onChange(candidate);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <Input
          aria-label={ariaLabel}
          type="number"
          min={0}
          step={1}
          form={NO_FORM_OWNER}
          value={text}
          onChange={(e) => handle(e.target.value)}
          aria-invalid={rejected || storedInvalid || Boolean(rangeNoteId) || undefined}
          aria-describedby={describedBy(
            rejected && rejectedId,
            empty && emptyId,
            storedInvalid && storedInvalidId,
            rangeNoteId,
          )}
          className="w-24"
        />
        {suffix && <span className="text-sm text-foreground-soft">{suffix}</span>}
      </div>
      {rejected && (
        <Note id={rejectedId} tone="critical">
          {message} Your entry was not applied
          {storedUsable ? `; this condition still uses ${stored}` : ""}.
        </Note>
      )}
      {empty && (
        <Note id={emptyId} tone="critical">
          No value entered yet, {MATCHES_NOBODY}.
        </Note>
      )}
      {storedInvalid && (
        <Note id={storedInvalidId} tone="critical">
          {stored} is not a whole number, {MATCHES_NOBODY}.
        </Note>
      )}
    </div>
  );
}

function CountRange({
  value,
  onChange,
}: {
  value: AudienceCondition["value"];
  onChange: (value: AudienceCondition["value"]) => void;
}) {
  const base = useId();
  const reversedId = `${base}-reversed`;
  const tooManyId = `${base}-too-many`;

  const [low, high] = asPair(value);
  // countWhere already returns match-nobody for lo > hi (operators.ts). Same
  // reasoning as the date range above: safe, but worth saying. The empty and
  // stored-not-a-number cases are reported by whichever nested WholeNumber has
  // them, so they are not repeated here.
  const reversed =
    WHOLE_NUMBER_RE.test(low) && WHOLE_NUMBER_RE.test(high) && Number(low) > Number(high);
  // countWhere's `between` runs the same asArray gate dateBoundaryFor does, so
  // a third value matches nobody here too. Warned rather than truncated, for
  // the reason given in DateRange.
  const tooMany = hasTooManyValues(value);
  const valueCount = usedValues(value).length;

  // Both warnings belong to the PAIR, so both boxes point at whichever one is
  // showing. WholeNumber cannot derive either on its own: it sees one endpoint.
  const rangeNoteId = reversed ? reversedId : tooMany ? tooManyId : undefined;

  function set(index: 0 | 1, next: AudienceCondition["value"]) {
    const pair: [string, string] = [low, high];
    pair[index] = asSingle(next);
    onChange(pair);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <WholeNumber
          value={low}
          onChange={(v) => set(0, v)}
          ariaLabel="Lowest value"
          message={WHOLE_COUNT_MESSAGE}
          rangeNoteId={rangeNoteId}
        />
        <span className="text-sm text-foreground-soft">and</span>
        <WholeNumber
          value={high}
          onChange={(v) => set(1, v)}
          ariaLabel="Highest value"
          message={WHOLE_COUNT_MESSAGE}
          rangeNoteId={rangeNoteId}
        />
      </div>
      {reversed && (
        <Note id={reversedId} tone="critical">
          This range ends below where it starts, {MATCHES_NOBODY}.
        </Note>
      )}
      {tooMany && (
        <Note id={tooManyId} tone="critical">
          This range was saved with {valueCount} values instead of two,{" "}
          {MATCHES_NOBODY}. Re-pick both numbers.
        </Note>
      )}
    </div>
  );
}
