"use client";
import { useState } from "react";
import { Input, Field } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { FieldPreview } from "@/modules/recruitment/components/field-preview";
import { SYSTEM_FIELDS } from "@/modules/recruitment/contract/system-fields";
import type { ContractBlock } from "@/modules/recruitment/contract/layout";

type Ctx = { firstName: string; orgName: string };
type Prefill = { firstName: string; lastName: string; email: string; netId: string; phone: string };

function renderVars(text: string, ctx: Ctx): string {
  // Escaped-text output only; substitutes {{firstName}} / {{orgName}} for preview.
  // Kept deliberately simple to avoid importing server-only render helpers into
  // this client component.
  return text
    .replace(/\{\{\s*firstName\s*\}\}/g, ctx.firstName)
    .replace(/\{\{\s*orgName\s*\}\}/g, ctx.orgName);
}

export function ContractField({
  block, prefill, ctx, err,
}: { block: ContractBlock; prefill: Prefill; ctx: Ctx; err: (k: string) => string | undefined }) {
  const [hasEpic, setHasEpic] = useState(false);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();

  if (block.kind === "agreement") {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">{block.title}</p>
        {block.body.trim() && (
          <p className="whitespace-pre-line text-sm text-foreground-soft">{renderVars(block.body, ctx)}</p>
        )}
        <Field label={`${block.title} (${block.signatureLabel})`} required>
          <Input name={`sig__${block.id}`} required />
        </Field>
        {err(`sig__${block.id}`) && <p className="mt-1 text-xs text-critical">{err(`sig__${block.id}`)}</p>}
      </div>
    );
  }

  if (block.kind === "custom_question") {
    return (
      <div>
        <FieldPreview
          f={{ key: `custom__${block.key}`, label: block.label, helpText: block.helpText ?? null, type: block.type, required: block.required, options: block.options ?? null, validation: null }}
          departments={[]}
          fieldError={err(`custom__${block.key}`)}
        />
      </div>
    );
  }

  // system_field
  const spec = SYSTEM_FIELDS[block.systemKey];
  const label = block.label ?? spec.defaultLabel;
  switch (spec.render) {
    case "epicBlock":
      return (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <label className="flex items-center gap-2 text-sm"><Checkbox name="epicNeeded" /><span>Epic access is required for my role</span></label>
          <label className="flex items-center gap-2 text-sm"><Checkbox name="hasEpic" checked={hasEpic} onChange={(e) => setHasEpic(e.target.checked)} /><span>I already have an Epic ID</span></label>
          {hasEpic && (
            <div>
              <Field label="Existing Epic ID" required><Input name="existingEpicId" required /></Field>
              {err("existingEpicId") && <p className="mt-1 text-xs text-critical">{err("existingEpicId")}</p>}
            </div>
          )}
          <Field label="Access type (if known)"><Input name="epicAccessType" /></Field>
          <label className="flex items-center gap-2 text-sm"><Checkbox name="worksWithYnhh" /><span>I currently work with Yale New Haven Hospital</span></label>
        </div>
      );
    case "hipaaBlock": {
      const maxHipaa = iso(today);
      const minHipaa = iso(new Date(today.getFullYear() - 5, today.getMonth(), today.getDate()));
      return (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <Field label="HIPAA completion date" required><Input name="hipaaCompletedAt" type="date" required min={minHipaa} max={maxHipaa} /></Field>
          {err("hipaaCompletedAt") && <p className="mt-1 text-xs text-critical">{err("hipaaCompletedAt")}</p>}
          <Field label="HIPAA certificate (PDF)" required>
            {/* eslint-disable-next-line no-restricted-syntax -- native file input, no file primitive exists */}
            <input name="hipaaFile" type="file" accept="application/pdf,image/*" className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground-soft hover:file:bg-muted-strong" />
          </Field>
          {err("hipaaFile") && <p className="mt-1 text-xs text-critical">{err("hipaaFile")}</p>}
        </div>
      );
    }
    case "checkbox":
      return <label className="flex items-center gap-2 text-sm"><Checkbox name={block.systemKey === "spanish" ? "spanishSelfReported" : "licensedRN"} /><span>{label}</span></label>;
    case "date": case "email": case "tel": case "text": default: {
      // "name" is special: two inputs (first + last).
      if (block.systemKey === "name") {
        return (
          <div className="space-y-4">
            <div>
              <Field label="First name" required><Input name="firstName" defaultValue={prefill.firstName} required /></Field>
              {err("firstName") && <p className="mt-1 text-xs text-critical">{err("firstName")}</p>}
            </div>
            <div>
              <Field label="Last name" required><Input name="lastName" defaultValue={prefill.lastName} required /></Field>
              {err("lastName") && <p className="mt-1 text-xs text-critical">{err("lastName")}</p>}
            </div>
          </div>
        );
      }
      const nameByKey: Record<string, string> = { email: "email", netId: "netId", phone: "phone", dob: "dateOfBirth", dietary: "dietaryRestrictions", yaleAffiliation: "yaleAffiliation", gradYear: "gradYear", initials: "initials" };
      const type = spec.render === "text" ? "text" : spec.render;
      const defaults: Record<string, string> = { email: prefill.email, netId: prefill.netId, phone: prefill.phone };
      const required = block.systemKey === "email" || block.systemKey === "initials";
      const inputName = nameByKey[block.systemKey];
      return (
        <div>
          <Field label={label} required={required}><Input name={inputName} type={type} defaultValue={defaults[block.systemKey]} required={required} /></Field>
          {err(inputName) && <p className="mt-1 text-xs text-critical">{err(inputName)}</p>}
        </div>
      );
    }
  }
}
