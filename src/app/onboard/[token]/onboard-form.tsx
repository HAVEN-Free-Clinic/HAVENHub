"use client";
import { useState } from "react";
import { submitOnboarding, type SubmitResult } from "./actions";

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
    return <p className="mt-8 rounded border border-green-300 bg-green-50 px-4 py-3 text-green-800">Thanks, your onboarding is complete. We will be in touch with next steps.</p>;
  }
  const err = (k: string) => (result && !result.ok ? result.fieldErrors?.[k] : undefined);
  const field = (label: string, name: string, opts: { type?: string; defaultValue?: string; required?: boolean } = {}) => (
    <label className="block text-sm">{label}{opts.required && <span className="text-red-600"> *</span>}
      <input name={name} type={opts.type ?? "text"} defaultValue={opts.defaultValue} required={opts.required} className="mt-1 w-full rounded border px-2 py-1" />
      {err(name) && <span className="block text-xs text-red-600">{err(name)}</span>}
    </label>
  );

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-6">
      {result && !result.ok && <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{result.message}</p>}
      <fieldset className="space-y-3"><legend className="text-sm font-semibold uppercase tracking-wide text-slate-400">Your information</legend>
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
      <fieldset className="space-y-3"><legend className="text-sm font-semibold uppercase tracking-wide text-slate-400">Acknowledgements</legend>
        {field("Volunteer agreement (type your full name)", "agreementSignature", { required: true })}
        {field("Professionalism policy (type your full name)", "professionalismSignature", { required: true })}
        {field("Training acknowledgement (type your full name)", "trainingSignature", { required: true })}
        {field("Initials", "initials", { required: true })}
      </fieldset>
      <fieldset className="space-y-3"><legend className="text-sm font-semibold uppercase tracking-wide text-slate-400">EPIC access</legend>
        <label className="block text-sm"><input type="checkbox" name="epicNeeded" /> EPIC access is required for my role</label>
        <label className="block text-sm"><input type="checkbox" name="hasEpic" checked={hasEpic} onChange={(e) => setHasEpic(e.target.checked)} /> I already have an EPIC ID</label>
        {hasEpic && field("Existing EPIC ID", "existingEpicId", { required: true })}
        {field("Access type (if known)", "epicAccessType")}
        <label className="block text-sm"><input type="checkbox" name="worksWithYnhh" /> I currently work with Yale New Haven Hospital</label>
      </fieldset>
      <fieldset className="space-y-3"><legend className="text-sm font-semibold uppercase tracking-wide text-slate-400">HIPAA</legend>
        {field("HIPAA completion date", "hipaaCompletedAt", { type: "date", required: true })}
        <label className="block text-sm">HIPAA certificate (PDF)<span className="text-red-600"> *</span>
          <input name="hipaaFile" type="file" accept="application/pdf,image/*" className="mt-1 w-full rounded border px-2 py-1" />
          {err("hipaaFile") && <span className="block text-xs text-red-600">{err("hipaaFile")}</span>}
        </label>
      </fieldset>
      <button disabled={submitting} className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">{submitting ? "Submitting..." : "Submit onboarding"}</button>
    </form>
  );
}
