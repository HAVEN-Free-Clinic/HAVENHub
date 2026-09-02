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
 * Anything else compiles to MATCH_NOBODY, which is safe (it never widens a send
 * list) but silent: the campaign goes to nobody and the builder looks fine. So
 * the controls here are narrow on purpose, and where the compiler would fail
 * quietly they say so out loud instead.
 *
 * ConditionRow keeps its own controls for every other field kind; this
 * component returns null for them rather than trying to be the one value
 * control for everything.
 */

import { useState } from "react";
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

function asPair(value: AudienceCondition["value"]): [string, string] {
  const list = Array.isArray(value) ? value : [];
  return [list[0] ?? "", list[1] ?? ""];
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
function ZoneNote({ zoneLabel }: { zoneLabel: string }) {
  return <span className="text-xs text-subtle-foreground">Dates are read in {zoneLabel}</span>;
}

/** Shown for a stored day that is correctly shaped but does not exist. */
function ImpossibleDateNote({ day }: { day: string }) {
  return (
    <span className="text-xs text-critical-foreground">
      {day} is not a real date, so this condition matches nobody.
    </span>
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
  const day = asSingle(value);
  // A native date input cannot produce "2026-02-30", but a stored audience can
  // (audienceJson is schema-less), and the browser renders such a value as an
  // EMPTY box. Without this note the sender sees a blank control, no reason,
  // and a campaign that matches nobody. See isCalendarDay in zoned-day.ts.
  const impossible = day !== "" && !isCalendarDay(day);

  return (
    <div className="flex flex-col gap-1">
      <Input
        aria-label="Date"
        type="date"
        value={day}
        onChange={(e) => onChange(e.target.value)}
        className="w-auto"
      />
      <ZoneNote zoneLabel={zoneLabel} />
      {impossible && <ImpossibleDateNote day={day} />}
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
  const [from, to] = asPair(value);
  const impossible = [from, to].filter((d) => d !== "" && !isCalendarDay(d));
  // The builder can produce a reversed range with two clicks, and Part A now
  // compiles it to the match-nobody sentinel rather than to an empty gte/lt
  // pair (see the `between` branch in operators.ts). Safe, but invisible unless
  // the control says so.
  const reversed =
    from !== "" && to !== "" && isCalendarDay(from) && isCalendarDay(to) && from > to;

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
          value={from}
          onChange={(e) => set(0, e.target.value)}
          className="w-auto"
        />
        <span className="text-sm text-foreground-soft">and</span>
        <Input
          aria-label="End date"
          type="date"
          value={to}
          onChange={(e) => set(1, e.target.value)}
          className="w-auto"
        />
      </div>
      <ZoneNote zoneLabel={zoneLabel} />
      {impossible.map((day) => (
        <ImpossibleDateNote key={day} day={day} />
      ))}
      {reversed && (
        <span className="text-xs text-critical-foreground">
          This range ends before it starts, so it matches nobody.
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Whole numbers: relative windows and count comparisons
// ---------------------------------------------------------------------------

/**
 * A whole, non-negative number, with the rejected text kept on screen.
 *
 * Two rules, both about not lying to the sender:
 *
 * 1. An invalid entry is never handed to onChange. `min`/`step` are advisory
 *    (a browser lets "-5" and "1.5" through the value, and only blocks them at
 *    form validation), and operators.ts would compile either to match-nobody:
 *    a campaign that silently sends to no one.
 * 2. An invalid entry CLEARS the stored value rather than leaving the last
 *    accepted number behind it. A box reading "-5" over a stored "30" is the
 *    "looks configured, sends something else" failure this builder's tests
 *    exist to catch. Cleared plus a visible message is honest: the condition is
 *    incomplete, and it says why.
 *
 * The typed text therefore has to live in local state, since it is exactly the
 * text the parent was NOT told about. `echo` records what this control last
 * handed up, so a value arriving from outside (an operator change, or React
 * reconciling a different condition into this position, since GroupEditor keys
 * children by index) still replaces the box contents, while this control's own
 * clearing does not wipe the text the sender is looking at.
 */
function WholeNumber({
  value,
  onChange,
  ariaLabel,
  suffix,
  message,
}: {
  value: AudienceCondition["value"];
  onChange: (value: AudienceCondition["value"]) => void;
  ariaLabel: string;
  suffix?: string;
  message: string;
}) {
  const incoming = asSingle(value);
  const [text, setText] = useState(incoming);
  const [echo, setEcho] = useState(incoming);

  if (incoming !== echo) {
    setEcho(incoming);
    setText(incoming);
  }

  const trimmed = text.trim();
  const invalid = trimmed !== "" && !WHOLE_NUMBER_RE.test(trimmed);

  function handle(next: string) {
    const accepted = WHOLE_NUMBER_RE.test(next.trim()) ? next.trim() : "";
    setText(next);
    setEcho(accepted);
    onChange(accepted);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <Input
          aria-label={ariaLabel}
          type="number"
          min={0}
          step={1}
          value={text}
          onChange={(e) => handle(e.target.value)}
          className="w-24"
        />
        {suffix && <span className="text-sm text-foreground-soft">{suffix}</span>}
      </div>
      {invalid && <span className="text-xs text-critical-foreground">{message}</span>}
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
  const [low, high] = asPair(value);
  const lowN = Number(low);
  const highN = Number(high);
  // countWhere already returns match-nobody for lo > hi (operators.ts). Same
  // reasoning as the date range above: safe, but worth saying.
  const reversed =
    WHOLE_NUMBER_RE.test(low) && WHOLE_NUMBER_RE.test(high) && lowN > highN;

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
        />
        <span className="text-sm text-foreground-soft">and</span>
        <WholeNumber
          value={high}
          onChange={(v) => set(1, v)}
          ariaLabel="Highest value"
          message={WHOLE_COUNT_MESSAGE}
        />
      </div>
      {reversed && (
        <span className="text-xs text-critical-foreground">
          This range ends below where it starts, so it matches nobody.
        </span>
      )}
    </div>
  );
}
