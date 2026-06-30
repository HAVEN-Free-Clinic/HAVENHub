// src/app/(app)/recruitment/cycles/[id]/builder/quiz/quiz-builder.tsx
"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { addSectionAction, addFieldAction, updateFieldAction, deleteFieldAction } from "../actions";
import { OptionsEditor } from "../options-editor";
import { type Choice } from "@/modules/recruitment/engine/options";
import { Field, Input } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";

export type QuizQuestion = { id: string; label: string; options: Choice[]; correctValue: string | null };
export type QuizSection = { id: string; title: string; questions: QuizQuestion[] };

export function QuizBuilder({
  cycleId, cycleTitle, editable, sections,
}: {
  cycleId: string;
  cycleTitle: string;
  editable: boolean;
  sections: QuizSection[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [newSectionTitle, setNewSectionTitle] = useState("");
  const refresh = () => router.refresh();

  // Quiz field edits are never "structural" in the service layer, so published-cycle protection here is UI-only: the disabled props below are the only guard. Keep them in sync with editable.

  function addQuizSection() {
    const title = newSectionTitle.trim() || "Quiz";
    startTransition(async () => { const r = await addSectionAction(cycleId, { title, appliesTo: "BOTH", departmentCode: null, purpose: "QUIZ" }); if (r.ok) { setNewSectionTitle(""); refresh(); } });
  }
  function addQuestion(sectionId: string) {
    startTransition(async () => {
      const r = await addFieldAction(cycleId, sectionId, { type: "SINGLE_SELECT" });
      if (!r.ok) return;
      refresh();
    });
  }
  function saveQuestion(fieldId: string, patch: Parameters<typeof updateFieldAction>[2]) {
    startTransition(async () => { const r = await updateFieldAction(cycleId, fieldId, patch); if (r.ok) refresh(); });
  }

  return (
    <div className="space-y-4">
      {!editable && <Alert tone="warning">This cycle is published. Quiz edits that change scoring are limited.</Alert>}

      <Card pad={false} className="overflow-hidden">
        <div className="h-2 bg-brand" aria-hidden />
        <div className="p-5"><h1 className="text-lg font-semibold text-foreground">{cycleTitle}</h1><p className="text-sm text-muted-foreground">Training quiz</p></div>
      </Card>

      {sections.map((section) => (
        <section key={section.id} className="rounded-2xl border border-border bg-muted/30 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{section.title}</h2>
          <div className="mt-3 space-y-4">
            {section.questions.map((q) => (
              <Card key={q.id} size="compact">
                <Field label="Question">
                  <Input defaultValue={q.label} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== q.label) saveQuestion(q.id, { label: v }); }} />
                </Field>
                <p className="mb-1 mt-3 text-xs font-medium text-subtle-foreground">Answers (select the correct one)</p>
                <OptionsEditor
                  options={q.options}
                  onChange={(next) => saveQuestion(q.id, { options: next })}
                  markCorrect={{ value: q.correctValue, onPick: (value) => saveQuestion(q.id, { correctValue: value }) }}
                  disabled={!editable}
                />
                <div className="mt-2 flex justify-end">
                  <form action={async () => { const r = await deleteFieldAction(cycleId, q.id); if (r.ok) refresh(); }}>
                    <ConfirmButton label="Remove question" size="sm" disabled={!editable} />
                  </form>
                </div>
              </Card>
            ))}
            {section.questions.length === 0 && <p className="text-sm text-subtle-foreground">No questions yet.</p>}
            <Button type="button" variant="outline" size="sm" disabled={!editable} onClick={() => addQuestion(section.id)}>
              <Plus className="h-4 w-4" aria-hidden /> Add question
            </Button>
          </div>
        </section>
      ))}

      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-dashed border-border-strong bg-muted/60 p-5">
        <Field label="Quiz section title">
          <Input value={newSectionTitle} onChange={(e) => setNewSectionTitle(e.target.value)} className="min-w-[14rem]" />
        </Field>
        <Button type="button" onClick={addQuizSection} disabled={!editable}>Add quiz section</Button>
      </div>
    </div>
  );
}
