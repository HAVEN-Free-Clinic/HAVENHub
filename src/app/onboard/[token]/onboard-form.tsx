"use client";
import { useState } from "react";
import { submitOnboarding, type SubmitResult } from "./actions";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";
import { Input } from "@/platform/ui/input";

type Prefill = { firstName: string; lastName: string; email: string; netId: string; phone: string };

export function OnboardForm({ token, prefill }: { token: string; prefill: Prefill }) {
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [hasEpic, setHasEpic] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    const res = await submitOnboarding(token, new FormData(e.currentTarget));
    setResult(res);
    setSubmitting(false);
  }
  if (result?.ok) {
    return <Alert tone="success" className="mt-8">Thanks, your onboarding is complete. We will be in touch with next steps.</Alert>;
  }
  const err = (k: string) => (result && !result.ok ? result.fieldErrors?.[k] : undefined);
  const field = (label: string, name: string, opts: { type?: string; defaultValue?: string; required?: boolean; min?: string; max?: string } = {}) => (
    <label className="block text-sm">{label}{opts.required && <span className="text-critical"> *</span>}
      <Input name={name} type={opts.type ?? "text"} defaultValue={opts.defaultValue} required={opts.required} min={opts.min} max={opts.max} className="mt-1" />
      {err(name) && <span className="block text-xs text-critical">{err(name)}</span>}
    </label>
  );

  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  const maxHipaa = iso(today);
  const minHipaa = iso(new Date(today.getFullYear() - 5, today.getMonth(), today.getDate()));

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-6">
      {result && !result.ok && <Alert tone="error">{result.message}</Alert>}
      <fieldset className="space-y-3 rounded-xl border border-border bg-surface p-4"><legend className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Your information</legend>
        {field("First name", "firstName", { defaultValue: prefill.firstName, required: true })}
        {field("Last name", "lastName", { defaultValue: prefill.lastName, required: true })}
        {field("Email", "email", { type: "email", defaultValue: prefill.email, required: true })}
        {field("NetID", "netId", { defaultValue: prefill.netId })}
        {field("Phone", "phone", { defaultValue: prefill.phone })}
        {field("Date of birth", "dateOfBirth", { type: "date" })}
        {field("Dietary restrictions", "dietaryRestrictions")}
        {field("Yale affiliation", "yaleAffiliation")}
        {field("Graduation year", "gradYear")}
      </fieldset>
      <fieldset className="space-y-3 rounded-xl border border-border bg-surface p-4"><legend className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Acknowledgements</legend>
        {field("Volunteer agreement (type your full name)", "agreementSignature", { required: true })}
        {field("Professionalism policy (type your full name)", "professionalismSignature", { required: true })}
        {field("Training acknowledgement (type your full name)", "trainingSignature", { required: true })}
        {field("Initials", "initials", { required: true })}
      </fieldset>
      <fieldset className="space-y-3 rounded-xl border border-border bg-surface p-4"><legend className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">EPIC access</legend>
        <label className="block text-sm"><input type="checkbox" name="epicNeeded" /> EPIC access is required for my role</label>
        <label className="block text-sm"><input type="checkbox" name="hasEpic" checked={hasEpic} onChange={(e) => setHasEpic(e.target.checked)} /> I already have an EPIC ID</label>
        {hasEpic && field("Existing EPIC ID", "existingEpicId", { required: true })}
        {field("Access type (if known)", "epicAccessType")}
        <label className="block text-sm"><input type="checkbox" name="worksWithYnhh" /> I currently work with Yale New Haven Hospital</label>
      </fieldset>
      <fieldset className="space-y-3 rounded-xl border border-border bg-surface p-4"><legend className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Background</legend>
        <label className="block text-sm"><input type="checkbox" name="spanishSelfReported" /> I can speak Spanish with patients</label>
        <label className="block text-sm"><input type="checkbox" name="licensedRN" /> I am a licensed RN</label>
      </fieldset>
      <fieldset className="space-y-3 rounded-xl border border-border bg-surface p-4"><legend className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">HIPAA</legend>
        {field("HIPAA completion date", "hipaaCompletedAt", { type: "date", required: true, min: minHipaa, max: maxHipaa })}
        <label className="block text-sm">HIPAA certificate (PDF)<span className="text-critical"> *</span>
          <Input name="hipaaFile" type="file" accept="application/pdf,image/*" className="mt-1 cursor-pointer" />
          {err("hipaaFile") && <span className="block text-xs text-critical">{err("hipaaFile")}</span>}
        </label>
      </fieldset>
      <Button type="submit" disabled={submitting}>{submitting ? "Submitting..." : "Submit onboarding"}</Button>
    </form>
  );
}
