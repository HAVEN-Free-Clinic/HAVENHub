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
import { SectionHeader } from "@/platform/ui/section-header";
import { EmptyState } from "@/platform/ui/empty-state";
import { FormRow } from "@/platform/ui/form";
import type { CycleStatus } from "@prisma/client";
import { CYCLE_STATUS_LABELS } from "@/modules/recruitment/components/status-badge";

export type QuizQuestion = { id: string; label: string; options: Choice[]; correctValue: string | null };
export type QuizSection = { id: string; title: string; questions: QuizQuestion[] };

export function QuizBuilder({
  cycleId, cycleTitle, editable, status, sections,
}: {
  cycleId: string;
  cycleTitle: string;
  editable: boolean;
  status: CycleStatus;
  sections: QuizSection[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [newSectionTitle, setNewSectionTitle] = useState("");
  // Every action here returns `{ ok: false, error }` on refusal and every one of
  // them used to discard it, so a rejected edit was indistinguishable from one
  // that never fired.
  const [error, setError] = useState<string | null>(null);
  const refresh = () => router.refresh();

  // Quiz field edits are never "structural" in the service layer (quiz sections
  // never invalidate applicant answers), so this lock is UI-only -- the disabled
  // props below are the only guard. editable now mirrors the relaxed
  // form-builder guard: unlocked through OPEN/CLOSED, locked once ARCHIVED.
  // Keep the disabled props in sync with editable.

  function addQuizSection() {
    const title = newSectionTitle.trim() || "Quiz";
    setError(null);
    startTransition(async () => {
      const r = await addSectionAction(cycleId, { title, appliesTo: "BOTH", departmentCode: null, purpose: "QUIZ" });
      if (r.ok) { setNewSectionTitle(""); refresh(); }
      else setError(r.error);
    });
  }
  function addQuestion(sectionId: string) {
    setError(null);
    startTransition(async () => {
      const r = await addFieldAction(cycleId, sectionId, { type: "SINGLE_SELECT" });
      if (r.ok) refresh();
      else setError(r.error);
    });
  }
  function saveQuestion(fieldId: string, patch: Parameters<typeof updateFieldAction>[2]) {
    setError(null);
    startTransition(async () => {
      const r = await updateFieldAction(cycleId, fieldId, patch);
      if (r.ok) refresh();
      else setError(r.error);
    });
  }

  return (
    <div className="space-y-4">
      {status !== "DRAFT" && (
        <Alert tone="warning">
          This cycle is {CYCLE_STATUS_LABELS[status].toLowerCase()}. Applicants may have already
          submitted. Changes take effect for new submissions
          immediately; existing answers are kept as-is and may no longer match the updated form.
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}

      <Card pad={false} className="overflow-hidden">
        <div className="h-2 bg-brand" aria-hidden />
        <div className="p-5"><h2 className="text-lg font-semibold text-foreground">{cycleTitle}</h2><p className="text-sm text-muted-foreground">Training quiz</p></div>
      </Card>

      {sections.map((section) => (
        <section key={section.id} className="rounded-2xl border border-border bg-muted/30 p-4">
          <SectionHeader>{section.title}</SectionHeader>
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
                  <form action={async () => { setError(null); const r = await deleteFieldAction(cycleId, q.id); if (r.ok) refresh(); else setError(r.error); }}>
                    <ConfirmButton label="Remove question" size="sm" disabled={!editable} />
                  </form>
                </div>
              </Card>
            ))}
            {section.questions.length === 0 && <EmptyState inline>No questions yet.</EmptyState>}
            <Button type="button" variant="outline" size="sm" disabled={!editable} onClick={() => addQuestion(section.id)}>
              <Plus className="h-4 w-4" aria-hidden /> Add question
            </Button>
          </div>
        </section>
      ))}

      <FormRow className="rounded-2xl border border-dashed border-border-strong bg-muted/60 p-5">
        <Field label="Quiz section title">
          <Input value={newSectionTitle} onChange={(e) => setNewSectionTitle(e.target.value)} className="min-w-[14rem]" />
        </Field>
        <Button type="button" onClick={addQuizSection} disabled={!editable}>Add quiz section</Button>
      </FormRow>
    </div>
  );
}
