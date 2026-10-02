"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Checkbox } from "@/platform/ui/checkbox";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { SubmitButton } from "@/platform/ui/submit-button";
import { SectionHeader } from "@/platform/ui/section-header";
import { FormRenderer } from "@/modules/forms/components/form-renderer";
import {
  QUESTION_TYPE_LABELS,
  QUESTION_TYPES,
  type FormLayout,
  type Question,
  type QuestionType,
} from "@/modules/forms/layout";

export type BuilderState = { problems: string[]; conflict?: boolean } | null;

type Settings = {
  title: string;
  description: string;
  openToAnyone: boolean;
  allowEdits: boolean;
  /** datetime-local wall time in the display zone, or "". */
  closesAt: string;
};

function newKey(taken: Set<string>): string {
  let key: string;
  do {
    key = `q_${Math.random().toString(36).slice(2, 8)}`;
  } while (taken.has(key));
  return key;
}

function blankQuestion(type: QuestionType, taken: Set<string>): Question {
  const key = newKey(taken);
  if (type === "section") return { key, type, label: "New section" };
  if (type === "single_choice" || type === "multi_choice") {
    return { key, type, label: "", options: ["Option 1", "Option 2"] };
  }
  if (type === "rating") return { key, type, label: "", scale: { max: 5 } };
  return { key, type, label: "" };
}

/**
 * The form editor. Holds the whole layout in state and posts it as one JSON
 * field; the server parses and validates it (parseFormLayout) and refuses a
 * save loaded at an older version, offering "Save anyway" like the campaign
 * editor.
 *
 * Question keys are generated once and never edited here: they are what
 * answers are stored under, so renaming one would orphan every response to it.
 */
export function FormBuilder({
  initialLayout,
  initialSettings,
  layoutVersion,
  responseCount,
  zoneLabel,
  action,
}: {
  initialLayout: FormLayout;
  initialSettings: Settings;
  layoutVersion: number;
  responseCount: number;
  zoneLabel: string;
  action: (prev: BuilderState, formData: FormData) => Promise<BuilderState>;
}) {
  const [state, formAction] = useActionState(action, null);
  const [questions, setQuestions] = useState<Question[]>(initialLayout.questions);
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [preview, setPreview] = useState(false);

  const initialJson = useMemo(
    () => JSON.stringify({ q: initialLayout.questions, s: initialSettings }),
    [initialLayout, initialSettings],
  );
  const dirty = JSON.stringify({ q: questions, s: settings }) !== initialJson;

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const taken = new Set(questions.map((q) => q.key));
  const update = (i: number, patch: Partial<Question>) =>
    setQuestions((qs) => qs.map((q, j) => (j === i ? ({ ...q, ...patch } as Question) : q)));
  const move = (i: number, by: number) =>
    setQuestions((qs) => {
      const j = i + by;
      if (j < 0 || j >= qs.length) return qs;
      const next = [...qs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const remove = (i: number) => setQuestions((qs) => qs.filter((_, j) => j !== i));
  const add = (type: QuestionType) => setQuestions((qs) => [...qs, blankQuestion(type, taken)]);
  const duplicate = (i: number) =>
    setQuestions((qs) => {
      const copy = { ...qs[i], key: newKey(taken), label: `${qs[i].label} (copy)` };
      return [...qs.slice(0, i + 1), copy, ...qs.slice(i + 1)];
    });

  const layoutJson = JSON.stringify({ questions });

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="layout" value={layoutJson} />
      <input type="hidden" name="layoutVersion" value={layoutVersion} />

      <Card className="space-y-4">
        <Field label="Title" required>
          <Input name="title" value={settings.title} onChange={(e) => setSettings({ ...settings, title: e.target.value })} />
        </Field>
        <Field label="Description" hint="Shown at the top of the form.">
          <Textarea
            name="description"
            rows={2}
            value={settings.description}
            onChange={(e) => setSettings({ ...settings, description: e.target.value })}
          />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={`Closes at (${zoneLabel})`} hint="Optional. After this, the form stops accepting responses.">
            <Input
              name="closesAt"
              type="datetime-local"
              value={settings.closesAt}
              onChange={(e) => setSettings({ ...settings, closesAt: e.target.value })}
            />
          </Field>
        </div>
        <Checkbox
          name="openToAnyone"
          checked={settings.openToAnyone}
          onChange={(e) => setSettings({ ...settings, openToAnyone: e.target.checked })}
          label="Anyone signed in with the link can respond"
          hint="Off: only the people you assign can respond. Everyone still signs in, so every response has a name."
        />
        <Checkbox
          name="allowEdits"
          checked={settings.allowEdits}
          onChange={(e) => setSettings({ ...settings, allowEdits: e.target.checked })}
          label="Respondents can change their answers while the form is open"
        />
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionHeader level="title">Questions</SectionHeader>
        <Button type="button" variant="outline" size="sm" onClick={() => setPreview((p) => !p)}>
          {preview ? "Back to editing" : "Preview"}
        </Button>
      </div>

      {responseCount > 0 && !preview && (
        <Alert tone="warning">
          This form already has {responseCount} {responseCount === 1 ? "response" : "responses"}. Each one
          keeps the questions it answered, but removing or retyping a question here changes how results
          are summarized. Prefer adding questions to changing existing ones.
        </Alert>
      )}

      {preview ? (
        <Card>
          <FormRenderer layout={{ questions }} />
        </Card>
      ) : (
        <ol className="space-y-4">
          {questions.map((q, i) => (
            <li key={q.key}>
              <QuestionEditor
                question={q}
                index={i}
                count={questions.length}
                earlier={questions.slice(0, i)}
                onChange={(patch) => update(i, patch)}
                onMove={(by) => move(i, by)}
                onRemove={() => remove(i)}
                onDuplicate={() => duplicate(i)}
              />
            </li>
          ))}
          {questions.length === 0 && (
            <li className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No questions yet. Add one below.
            </li>
          )}
        </ol>
      )}

      {!preview && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => add("short_text")}>
            Add question
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => add("section")}>
            Add section heading
          </Button>
        </div>
      )}

      <div className="sticky bottom-0 -mx-1 space-y-2 border-t border-border bg-surface py-3">
        {state && (
          <Alert tone="error">
            {state.problems.length === 1 ? (
              state.problems[0]
            ) : (
              <ul className="list-disc pl-5">
                {state.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
          {state?.conflict && (
            <SubmitButton name="overwrite" value="1" variant="danger" pendingLabel="Saving…">
              Save anyway
            </SubmitButton>
          )}
          {dirty && <span className="text-sm text-muted-foreground">Unsaved changes</span>}
        </div>
      </div>
    </form>
  );
}

function QuestionEditor({
  question: q,
  index,
  count,
  earlier,
  onChange,
  onMove,
  onRemove,
  onDuplicate,
}: {
  question: Question;
  index: number;
  count: number;
  earlier: Question[];
  onChange: (patch: Partial<Question>) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const isChoice = q.type === "single_choice" || q.type === "multi_choice";
  const conditionTargets = earlier.filter((e) => e.type !== "section");
  const target = conditionTargets.find((t) => t.key === q.visibleWhen?.field);
  const n = `Question ${index + 1}`;

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <Field label={q.type === "section" ? "Section heading" : "Question"}>
            <Input
              name={`label_${q.key}`}
              value={q.label}
              placeholder={q.type === "section" ? "e.g. About your interview" : "Type the question"}
              onChange={(e) => onChange({ label: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Type">
          <Select
            name={`type_${q.key}`}
            value={q.type}
            className="w-auto"
            onChange={(e) => {
              const type = e.target.value as QuestionType;
              onChange({
                type,
                options: type === "single_choice" || type === "multi_choice" ? (q.options?.length ? q.options : ["Option 1", "Option 2"]) : undefined,
                scale: type === "rating" ? (q.scale ?? { max: 5 }) : undefined,
                required: type === "section" ? undefined : q.required,
              });
            }}
          >
            {QUESTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {QUESTION_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Help text" hint="Optional. Shown under the question.">
        <Input name={`help_${q.key}`} value={q.help ?? ""} onChange={(e) => onChange({ help: e.target.value || undefined })} />
      </Field>

      {isChoice && (
        <Field label="Options" hint="One per line.">
          <Textarea
            name={`options_${q.key}`}
            rows={Math.min(Math.max(q.options?.length ?? 2, 2), 10)}
            value={(q.options ?? []).join("\n")}
            onChange={(e) => onChange({ options: e.target.value.split("\n").map((o) => o.trimStart()) })}
            onBlur={(e) =>
              onChange({ options: [...new Set(e.target.value.split("\n").map((o) => o.trim()).filter(Boolean))] })
            }
          />
        </Field>
      )}
      {q.type === "multi_choice" && (
        <Checkbox
          label={`Add an "Other" option with a write-in`}
          checked={q.allowOther ?? false}
          onChange={(e) => onChange({ allowOther: e.target.checked || undefined })}
        />
      )}

      {q.type === "rating" && (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Scale">
            <Select
              name={`scale_${q.key}`}
              value={String(q.scale?.max ?? 5)}
              className="w-auto"
              onChange={(e) => onChange({ scale: { ...q.scale, max: Number(e.target.value) } })}
            >
              {[3, 4, 5, 7, 10].map((m) => (
                <option key={m} value={m}>
                  1 to {m}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Low label">
            <Input
              name={`low_${q.key}`}
              value={q.scale?.lowLabel ?? ""}
              placeholder="e.g. Poor"
              onChange={(e) => onChange({ scale: { max: q.scale?.max ?? 5, ...q.scale, lowLabel: e.target.value || undefined } })}
            />
          </Field>
          <Field label="High label">
            <Input
              name={`high_${q.key}`}
              value={q.scale?.highLabel ?? ""}
              placeholder="e.g. Excellent"
              onChange={(e) => onChange({ scale: { max: q.scale?.max ?? 5, ...q.scale, highLabel: e.target.value || undefined } })}
            />
          </Field>
        </div>
      )}

      {q.type !== "section" && conditionTargets.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Show only if">
            <Select
              name={`cond_${q.key}`}
              value={q.visibleWhen?.field ?? ""}
              className="w-auto max-w-xs"
              onChange={(e) =>
                onChange({
                  visibleWhen: e.target.value ? { field: e.target.value, op: "isAnswered" } : undefined,
                })
              }
            >
              <option value="">Always show</option>
              {conditionTargets.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label || "(untitled question)"}
                </option>
              ))}
            </Select>
          </Field>
          {q.visibleWhen && target && (
            <Field label="Answer">
              <Select
                name={`condval_${q.key}`}
                value={q.visibleWhen.op === "isAnswered" ? "" : String(q.visibleWhen.value ?? "")}
                className="w-auto max-w-xs"
                onChange={(e) =>
                  onChange({
                    visibleWhen: e.target.value
                      ? { field: target.key, op: "is", value: e.target.value }
                      : { field: target.key, op: "isAnswered" },
                  })
                }
              >
                <option value="">is answered</option>
                {(target.type === "rating"
                  ? Array.from({ length: target.scale?.max ?? 5 }, (_, i) => String(i + 1))
                  : (target.options ?? [])
                ).map((o) => (
                  <option key={o} value={o}>
                    is {o}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        {q.type !== "section" ? (
          <Checkbox label="Required" checked={q.required ?? false} onChange={(e) => onChange({ required: e.target.checked || undefined })} />
        ) : (
          <span />
        )}
        <div className="flex flex-wrap gap-1">
          <Button type="button" variant="ghost" size="sm" aria-label={`Move ${n} up`} disabled={index === 0} onClick={() => onMove(-1)}>
            Up
          </Button>
          <Button type="button" variant="ghost" size="sm" aria-label={`Move ${n} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
            Down
          </Button>
          <Button type="button" variant="ghost" size="sm" aria-label={`Duplicate ${n}`} onClick={onDuplicate}>
            Duplicate
          </Button>
          <Button type="button" variant="ghost" size="sm" aria-label={`Delete ${n}`} onClick={onRemove}>
            Delete
          </Button>
        </div>
      </div>
    </Card>
  );
}
