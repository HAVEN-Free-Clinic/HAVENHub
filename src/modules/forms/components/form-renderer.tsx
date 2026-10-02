"use client";

import { useState } from "react";
import { Input, Textarea } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { Radio, RadioGroup } from "@/platform/ui/radio";
import { SectionHeader } from "@/platform/ui/section-header";
import { isQuestionVisible, OTHER_PREFIX, type Answers, type FormLayout, type Question } from "../layout";

/**
 * Renders a form's questions and keeps the answers in state, posting them as
 * one JSON hidden input named `answers`. One field rather than a name per
 * control because "Other" write-ins and hidden questions both need the answer
 * set assembled, and the server re-validates all of it anyway (validateAnswers).
 *
 * Used by the respondent's page and by the builder's preview, which passes
 * `readOnly` off and no form around it, so the preview is the real thing.
 */
export function FormRenderer({
  layout,
  initial = {},
  readOnly = false,
}: {
  layout: FormLayout;
  initial?: Answers;
  readOnly?: boolean;
}) {
  const [answers, setAnswers] = useState<Answers>(initial);
  const set = (key: string, value: string | string[] | undefined) =>
    setAnswers((a) => ({ ...a, [key]: value }));

  // Only answers to questions still showing are posted, mirroring the server.
  const visible = layout.questions.filter((q) => isQuestionVisible(q, answers));
  // A ticked "Other" with nothing written yet is not an answer: dropped here
  // rather than posted and refused.
  const posted = Object.fromEntries(
    visible
      .filter((q) => q.type !== "section" && answers[q.key] !== undefined)
      .map((q) => {
        const v = answers[q.key];
        return [q.key, Array.isArray(v) ? v.filter((x) => x !== OTHER_PREFIX && x.trim() !== OTHER_PREFIX.trim()) : v];
      }),
  );

  let number = 0;
  return (
    <div className="space-y-6">
      <input type="hidden" name="answers" value={JSON.stringify(posted)} />
      {visible.map((q) => {
        if (q.type === "section") {
          return (
            <div key={q.key} className="border-t border-border pt-6 first:border-t-0 first:pt-0">
              <SectionHeader level="title">{q.label}</SectionHeader>
              {q.help && <p className="mt-1 text-sm text-muted-foreground">{q.help}</p>}
            </div>
          );
        }
        number++;
        return (
          <QuestionField
            key={q.key}
            question={q}
            number={number}
            value={answers[q.key]}
            onChange={(v) => set(q.key, v)}
            readOnly={readOnly}
          />
        );
      })}
    </div>
  );
}

function QuestionField({
  question: q,
  number,
  value,
  onChange,
  readOnly,
}: {
  question: Question;
  number: number;
  value: string | string[] | undefined;
  onChange: (v: string | string[] | undefined) => void;
  readOnly: boolean;
}) {
  const id = `q-${q.key}`;
  const label = (
    <>
      <span className="text-muted-foreground">{number}. </span>
      {q.label}
      {q.required && (
        <span className="text-critical-foreground" aria-hidden="true">
          {" "}*
        </span>
      )}
    </>
  );
  const help = q.help ? (
    <p id={`${id}-help`} className="text-sm text-muted-foreground">
      {q.help}
    </p>
  ) : null;
  const describedBy = q.help ? `${id}-help` : undefined;

  if (q.type === "short_text" || q.type === "long_text") {
    const text = typeof value === "string" ? value : "";
    return (
      <div className="space-y-1.5">
        <label htmlFor={id} className="block text-sm font-medium text-foreground">
          {label}
        </label>
        {help}
        {q.type === "short_text" ? (
          <Input
            id={id}
            value={text}
            maxLength={500}
            required={q.required}
            aria-describedby={describedBy}
            disabled={readOnly}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <Textarea
            id={id}
            value={text}
            rows={4}
            maxLength={10_000}
            required={q.required}
            aria-describedby={describedBy}
            disabled={readOnly}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </div>
    );
  }

  if (q.type === "single_choice") {
    return (
      <fieldset className="space-y-1.5" aria-describedby={describedBy}>
        <legend className="text-sm font-medium text-foreground">{label}</legend>
        {help}
        <RadioGroup>
          {(q.options ?? []).map((o) => (
            <Radio
              key={o}
              name={id}
              value={o}
              label={o}
              checked={value === o}
              required={q.required}
              disabled={readOnly}
              onChange={() => onChange(o)}
            />
          ))}
        </RadioGroup>
      </fieldset>
    );
  }

  if (q.type === "multi_choice") {
    const list = Array.isArray(value) ? value : [];
    const other = list.find((v) => v.startsWith(OTHER_PREFIX));
    const otherText = other ? other.slice(OTHER_PREFIX.length) : "";
    const otherOn = other !== undefined;
    const withoutOther = list.filter((v) => !v.startsWith(OTHER_PREFIX));
    const setOtherOn = (on: boolean) => onChange(on ? [...withoutOther, OTHER_PREFIX] : withoutOther);
    const toggle = (o: string, on: boolean) =>
      onChange(on ? [...list, o] : list.filter((v) => v !== o));
    return (
      <fieldset className="space-y-1.5" aria-describedby={describedBy}>
        <legend className="text-sm font-medium text-foreground">{label}</legend>
        {help}
        <div className="flex flex-col gap-2">
          {(q.options ?? []).map((o) => (
            <Checkbox
              key={o}
              label={o}
              checked={list.includes(o)}
              disabled={readOnly}
              onChange={(e) => toggle(o, e.target.checked)}
            />
          ))}
          {q.allowOther && (
            <div className="flex flex-wrap items-center gap-2">
              <Checkbox label="Other" checked={otherOn} disabled={readOnly} onChange={(e) => setOtherOn(e.target.checked)} />
              {otherOn && (
                <Input
                  aria-label={`Other answer for ${q.label}`}
                  value={otherText}
                  maxLength={300}
                  disabled={readOnly}
                  className="w-64"
                  onChange={(e) => onChange([...withoutOther, `${OTHER_PREFIX}${e.target.value}`])}
                />
              )}
            </div>
          )}
        </div>
      </fieldset>
    );
  }

  // rating
  const max = q.scale?.max ?? 5;
  return (
    <fieldset className="space-y-1.5" aria-describedby={describedBy}>
      <legend className="text-sm font-medium text-foreground">{label}</legend>
      {help}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {q.scale?.lowLabel && <span className="text-xs text-muted-foreground">{q.scale.lowLabel}</span>}
        {Array.from({ length: max }, (_, i) => String(i + 1)).map((n) => (
          <Radio
            key={n}
            name={id}
            value={n}
            label={n}
            checked={value === n}
            required={q.required}
            disabled={readOnly}
            onChange={() => onChange(n)}
          />
        ))}
        {q.scale?.highLabel && <span className="text-xs text-muted-foreground">{q.scale.highLabel}</span>}
      </div>
    </fieldset>
  );
}
