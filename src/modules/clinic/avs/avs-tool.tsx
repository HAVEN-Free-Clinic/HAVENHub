"use client";

import { useReducer, useState } from "react";
import { pdf } from "@react-pdf/renderer";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { PageHeader } from "@/platform/ui/page-header";
import { Select } from "@/platform/ui/select";
import { AvsDocument } from "./avs-pdf";
import { buildSummary } from "./build-summary";
import { avsReducer, initialAvsData, type StringFieldKey } from "./form-state";
import {
  COMMUNITY_RESOURCES,
  FINANCIAL_RESOURCES,
  FOLLOW_UP,
  LABS,
  VITALS,
  type OptionList,
} from "./strings";
import type { AvsData } from "./types";

function validate(data: AvsData): string[] {
  const errs: string[] = [];
  if (!data.lastName.trim()) errs.push("Last name is required.");
  if (!data.visitDate.trim()) errs.push("Visit date is required.");
  if (!data.primaryReason.trim()) errs.push("Reason for visit is required.");
  return errs;
}

export function AvsTool() {
  const [data, dispatch] = useReducer(avsReducer, initialAvsData);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const setField = (key: StringFieldKey) => (e: { target: { value: string } }) =>
    dispatch({ type: "setField", key, value: e.target.value });

  async function handleGenerate() {
    const errs = validate(data);
    if (errs.length) {
      setErrors(errs);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    setErrors([]);
    setBusy(true);
    try {
      const summary = buildSummary(data, data.preferredLang);
      const blob = await pdf(<AvsDocument summary={summary} />).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `AVS-${data.lastName.trim() || "patient"}-${data.visitDate || "visit"}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setErrors(["Could not generate the PDF. Please try again."]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-16">
      <PageHeader
        title="After Visit Summary"
        description="Fill in the visit details and download a patient handout. Nothing is saved."
        action={
          <Button type="button" onClick={handleGenerate} disabled={busy}>
            {busy ? "Generating..." : "Generate PDF"}
          </Button>
        }
      />

      {errors.length > 0 && (
        <Alert tone="error">
          {errors.map((e, i) => (
            <span key={i} className="block">
              {e}
            </span>
          ))}
        </Alert>
      )}

      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-brand">Patient information</h2>
          <label className="flex items-center gap-2 text-xs font-medium text-slate-500">
            Summary language
            <Select
              value={data.preferredLang}
              onChange={(e) => dispatch({ type: "setLang", value: e.target.value as "en" | "es" })}
              className="w-32"
            >
              <option value="en">English</option>
              <option value="es">Español</option>
            </Select>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="First name">
            <Input value={data.firstName} onChange={setField("firstName")} placeholder="Maria" />
          </Field>
          <Field label="Last name *">
            <Input required value={data.lastName} onChange={setField("lastName")} placeholder="Garcia" />
          </Field>
          <Field label="Date of birth">
            <Input type="date" value={data.dob} onChange={setField("dob")} />
          </Field>
          <Field label="Visit date *">
            <Input type="date" required value={data.visitDate} onChange={setField("visitDate")} />
          </Field>
          <Field label="Provider / clinician">
            <Input value={data.provider} onChange={setField("provider")} placeholder="Dr. Smith" />
          </Field>
          <Field label="Patient ID">
            <Input value={data.patientId} onChange={setField("patientId")} placeholder="HC-000000" />
          </Field>
        </div>
      </Card>

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-brand">Visit details</h2>
        <Field label="Reason for visit *">
          <Input
            required
            value={data.primaryReason}
            onChange={setField("primaryReason")}
            placeholder="Hypertension follow-up"
          />
        </Field>
        <Field label="Diagnoses / conditions" hint="One per line. Printed as typed.">
          <Textarea value={data.diagnoses} onChange={setField("diagnoses")} rows={3} />
        </Field>
        <Field label="Notes for patient" hint="Plain language. Printed as typed.">
          <Textarea value={data.clinicalNotes} onChange={setField("clinicalNotes")} rows={3} />
        </Field>
        <ChipGroup
          label="Vitals reviewed"
          list={VITALS}
          selected={data.vitals}
          onToggle={(value) => dispatch({ type: "toggle", key: "vitals", value })}
        />
      </Card>

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-brand">Medications</h2>
        {data.medications.map((m, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
            <Field label="Medication">
              <Input
                value={m.name}
                onChange={(e) => dispatch({ type: "updateMed", index: i, key: "name", value: e.target.value })}
              />
            </Field>
            <Field label="Dose & instructions">
              <Input
                value={m.dose}
                onChange={(e) => dispatch({ type: "updateMed", index: i, key: "dose", value: e.target.value })}
              />
            </Field>
            <Field label="Lowest-cost source">
              <Input
                value={m.costSource}
                onChange={(e) => dispatch({ type: "updateMed", index: i, key: "costSource", value: e.target.value })}
              />
            </Field>
            <Button type="button" variant="ghost" onClick={() => dispatch({ type: "removeMed", index: i })} aria-label="Remove medication">
              ✕
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => dispatch({ type: "addMed" })}>
          + Add medication
        </Button>
      </Card>

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-brand">Next steps</h2>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Follow-up">
            <Select value={data.followUpTimeframe} onChange={setField("followUpTimeframe")}>
              <option value="">Select timeframe</option>
              {FOLLOW_UP.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.en}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Follow-up note">
            <Input value={data.followUpNote} onChange={setField("followUpNote")} placeholder="Blood pressure check" />
          </Field>
        </div>
        <ChipGroup
          label="Labs / tests ordered"
          list={LABS}
          selected={data.labs}
          onToggle={(value) => dispatch({ type: "toggle", key: "labs", value })}
        />
        <div className="space-y-2">
          <span className="text-xs font-medium text-slate-500">Action items</span>
          {data.actionItems.map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={item}
                onChange={(e) => dispatch({ type: "updateActionItem", index: i, value: e.target.value })}
              />
              <Button type="button" variant="ghost" onClick={() => dispatch({ type: "removeActionItem", index: i })} aria-label="Remove action item">
                ✕
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => dispatch({ type: "addActionItem" })}>
            + Add action item
          </Button>
        </div>
        <Field label="Lifestyle recommendations" hint="Printed as typed.">
          <Textarea value={data.lifestyle} onChange={setField("lifestyle")} rows={2} />
        </Field>
      </Card>

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-brand">Resources</h2>
        <ChipGroup
          label="Community resources"
          list={COMMUNITY_RESOURCES}
          selected={data.communityResources}
          onToggle={(value) => dispatch({ type: "toggle", key: "communityResources", value })}
        />
        <ChipGroup
          label="Financial resources"
          list={FINANCIAL_RESOURCES}
          selected={data.financialResources}
          onToggle={(value) => dispatch({ type: "toggle", key: "financialResources", value })}
        />
        <Field label="Additional resource">
          <Input
            value={data.customResource}
            onChange={setField("customResource")}
            placeholder="Local YMCA, free membership: (555) 000-0000"
          />
        </Field>
      </Card>

      <div className="flex justify-end">
        <Button type="button" onClick={handleGenerate} disabled={busy}>
          {busy ? "Generating..." : "Generate PDF"}
        </Button>
      </div>
    </div>
  );
}

function ChipGroup({
  label,
  list,
  selected,
  onToggle,
}: {
  label: string;
  list: OptionList;
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-slate-500">{label}</span>
      <div className="flex flex-wrap gap-2">
        {list.map((o) => {
          const on = selected.includes(o.key);
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => onToggle(o.key)}
              aria-pressed={on}
              className={
                on
                  ? "rounded-lg border border-brand bg-brand/10 px-3 py-1.5 text-sm font-medium text-brand"
                  : "rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 hover:border-brand/40"
              }
            >
              {o.en}
            </button>
          );
        })}
      </div>
    </div>
  );
}
