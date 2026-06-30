"use client";
import { useState } from "react";
import { submitOnboarding, type SubmitResult } from "./actions";
import { Alert } from "@/platform/ui/alert";
import { Input, Field } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Card } from "@/platform/ui/card";
import { FormSection, FormActions } from "@/platform/ui/form";

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

  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  const maxHipaa = iso(today);
  const minHipaa = iso(new Date(today.getFullYear() - 5, today.getMonth(), today.getDate()));

  return (
    <form onSubmit={onSubmit} className="mt-6">
      <Card className="space-y-6">
        {result && !result.ok && <Alert tone="error">{result.message}</Alert>}

        <FormSection title="Your information">
          <div>
            <Field label="First name">
              <Input name="firstName" defaultValue={prefill.firstName} required />
            </Field>
            {err("firstName") && <p className="mt-1 text-xs text-critical">{err("firstName")}</p>}
          </div>
          <div>
            <Field label="Last name">
              <Input name="lastName" defaultValue={prefill.lastName} required />
            </Field>
            {err("lastName") && <p className="mt-1 text-xs text-critical">{err("lastName")}</p>}
          </div>
          <div>
            <Field label="Email">
              <Input name="email" type="email" defaultValue={prefill.email} required />
            </Field>
            {err("email") && <p className="mt-1 text-xs text-critical">{err("email")}</p>}
          </div>
          <div>
            <Field label="NetID">
              <Input name="netId" defaultValue={prefill.netId} />
            </Field>
            {err("netId") && <p className="mt-1 text-xs text-critical">{err("netId")}</p>}
          </div>
          <div>
            <Field label="Phone">
              <Input name="phone" defaultValue={prefill.phone} />
            </Field>
            {err("phone") && <p className="mt-1 text-xs text-critical">{err("phone")}</p>}
          </div>
          <div>
            <Field label="Date of birth">
              <Input name="dateOfBirth" type="date" />
            </Field>
            {err("dateOfBirth") && <p className="mt-1 text-xs text-critical">{err("dateOfBirth")}</p>}
          </div>
          <div>
            <Field label="Dietary restrictions">
              <Input name="dietaryRestrictions" />
            </Field>
            {err("dietaryRestrictions") && <p className="mt-1 text-xs text-critical">{err("dietaryRestrictions")}</p>}
          </div>
          <div>
            <Field label="Yale affiliation">
              <Input name="yaleAffiliation" />
            </Field>
            {err("yaleAffiliation") && <p className="mt-1 text-xs text-critical">{err("yaleAffiliation")}</p>}
          </div>
          <div>
            <Field label="Graduation year">
              <Input name="gradYear" />
            </Field>
            {err("gradYear") && <p className="mt-1 text-xs text-critical">{err("gradYear")}</p>}
          </div>
        </FormSection>

        <FormSection title="Acknowledgements">
          <div>
            <Field label="Volunteer agreement (type your full name)">
              <Input name="agreementSignature" required />
            </Field>
            {err("agreementSignature") && <p className="mt-1 text-xs text-critical">{err("agreementSignature")}</p>}
          </div>
          <div>
            <Field label="Professionalism policy (type your full name)">
              <Input name="professionalismSignature" required />
            </Field>
            {err("professionalismSignature") && <p className="mt-1 text-xs text-critical">{err("professionalismSignature")}</p>}
          </div>
          <div>
            <Field label="Training acknowledgement (type your full name)">
              <Input name="trainingSignature" required />
            </Field>
            {err("trainingSignature") && <p className="mt-1 text-xs text-critical">{err("trainingSignature")}</p>}
          </div>
          <div>
            <Field label="Initials">
              <Input name="initials" required />
            </Field>
            {err("initials") && <p className="mt-1 text-xs text-critical">{err("initials")}</p>}
          </div>
        </FormSection>

        <FormSection title="EPIC access">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="epicNeeded" />
            <span>EPIC access is required for my role</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="hasEpic" checked={hasEpic} onChange={(e) => setHasEpic(e.target.checked)} />
            <span>I already have an EPIC ID</span>
          </label>
          {hasEpic && (
            <div>
              <Field label="Existing EPIC ID">
                <Input name="existingEpicId" required />
              </Field>
              {err("existingEpicId") && <p className="mt-1 text-xs text-critical">{err("existingEpicId")}</p>}
            </div>
          )}
          <div>
            <Field label="Access type (if known)">
              <Input name="epicAccessType" />
            </Field>
            {err("epicAccessType") && <p className="mt-1 text-xs text-critical">{err("epicAccessType")}</p>}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="worksWithYnhh" />
            <span>I currently work with Yale New Haven Hospital</span>
          </label>
        </FormSection>

        <FormSection title="Background">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="spanishSelfReported" />
            <span>I can speak Spanish with patients</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="licensedRN" />
            <span>I am a licensed RN</span>
          </label>
        </FormSection>

        <FormSection title="HIPAA">
          <div>
            <Field label="HIPAA completion date">
              <Input name="hipaaCompletedAt" type="date" required min={minHipaa} max={maxHipaa} />
            </Field>
            {err("hipaaCompletedAt") && <p className="mt-1 text-xs text-critical">{err("hipaaCompletedAt")}</p>}
          </div>
          <div>
            <Field label="HIPAA certificate (PDF)">
              <Input name="hipaaFile" type="file" accept="application/pdf,image/*" className="cursor-pointer" />
            </Field>
            {err("hipaaFile") && <p className="mt-1 text-xs text-critical">{err("hipaaFile")}</p>}
          </div>
        </FormSection>

        <FormActions>
          <SubmitButton disabled={submitting}>{submitting ? "Submitting..." : "Submit onboarding"}</SubmitButton>
        </FormActions>
      </Card>
    </form>
  );
}
