"use client";
import { useState } from "react";
import { Input, Field } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { Select } from "@/platform/ui/select";
import { SignaturePad } from "@/platform/ui/signature-pad";
import { FieldPreview } from "@/modules/recruitment/components/field-preview";
import { SYSTEM_FIELDS, systemFieldOptions } from "@/modules/recruitment/contract/system-fields";
import type { ContractBlock } from "@/modules/recruitment/contract/layout";

// todayIso is stamped once on the server (YYYY-MM-DD) and passed down, so the
// HIPAA date bounds are identical between the server render and client hydration
// (a render-body new Date() would differ across the request/hydration boundary).
type Ctx = { firstName: string; orgName: string; todayIso: string };
type Prefill = { firstName: string; lastName: string; email: string; netId: string; phone: string; yaleAffiliation: string; gradYear: string; spanish: boolean };

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

  // Tie each field's error message to its control so screen readers announce it
  // on focus and mark the input invalid. errorId derives a stable id per field
  // name; errorProps wires aria-invalid + aria-describedby onto the input.
  const errorId = (name: string) => `${name.replace(/[^\w-]/g, "_")}-error`;
  const errorProps = (name: string): { "aria-invalid": boolean; "aria-describedby"?: string } =>
    err(name) ? { "aria-invalid": true, "aria-describedby": errorId(name) } : { "aria-invalid": false };

  if (block.kind === "agreement") {
    return (
      <div className="space-y-2">
        {block.body.trim() && (
          <>
            <p className="text-sm font-medium text-foreground">{block.title}</p>
            <p className="whitespace-pre-line text-sm text-foreground-soft">{renderVars(block.body, ctx)}</p>
          </>
        )}
        <SignaturePad
          name={`sig__${block.id}`}
          label={block.title}
          required
          personName={`${prefill.firstName} ${prefill.lastName}`.trim()}
          error={err(`sig__${block.id}`)}
        />
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
              <Field label="Existing Epic ID" required><Input name="existingEpicId" required {...errorProps("existingEpicId")} /></Field>
              {err("existingEpicId") && <p id={errorId("existingEpicId")} className="mt-1 text-xs text-critical">{err("existingEpicId")}</p>}
            </div>
          )}
          <Field label="Access type (if known)"><Input name="epicAccessType" /></Field>
          <label className="flex items-center gap-2 text-sm"><Checkbox name="worksWithYnhh" /><span>I currently work with Yale New Haven Hospital</span></label>
        </div>
      );
    case "hipaaBlock": {
      // Deterministic string math off the server-stamped date -- no new Date() in
      // render, so the bounds hydrate identically. Certificates older than 5 years
      // are not accepted, and completion cannot be in the future.
      const maxHipaa = ctx.todayIso;
      const [ty, tm, td] = ctx.todayIso.split("-");
      const minHipaa = `${Number(ty) - 5}-${tm}-${td}`;
      return (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <Field label="HIPAA completion date" required><Input name="hipaaCompletedAt" type="date" required min={minHipaa} max={maxHipaa} {...errorProps("hipaaCompletedAt")} /></Field>
          {err("hipaaCompletedAt") && <p id={errorId("hipaaCompletedAt")} className="mt-1 text-xs text-critical">{err("hipaaCompletedAt")}</p>}
          <Field label="HIPAA certificate (PDF)" required>
            {/* eslint-disable-next-line no-restricted-syntax -- native file input, no file primitive exists */}
            <input name="hipaaFile" type="file" accept="application/pdf,image/*" {...errorProps("hipaaFile")} className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground-soft hover:file:bg-muted-strong" />
          </Field>
          {err("hipaaFile") && <p id={errorId("hipaaFile")} className="mt-1 text-xs text-critical">{err("hipaaFile")}</p>}
        </div>
      );
    }
    case "checkbox":
      return (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            name={block.systemKey === "spanish" ? "spanishSelfReported" : "licensedRN"}
            defaultChecked={block.systemKey === "spanish" ? prefill.spanish : false}
          />
          <span>{label}</span>
        </label>
      );
    case "select": {
      // yaleAffiliation / gradYear store stable machine keys ("other_yale"), so a
      // plain text input showed applicants the key instead of the label. Options
      // carry the key as the value, keeping what gets submitted unchanged.
      const inputName = block.systemKey;
      // Mirrors the text branch's `defaults` map: a select field added later
      // without an entry here starts empty rather than silently inheriting
      // another field's value.
      const selectDefaults: Partial<Record<typeof block.systemKey, string>> = {
        yaleAffiliation: prefill.yaleAffiliation,
        gradYear: prefill.gradYear,
      };
      const current = selectDefaults[block.systemKey] ?? "";
      return (
        <div>
          <Field label={label}>
            <Select name={inputName} defaultValue={current} {...errorProps(inputName)}>
              <option value="">Select…</option>
              {systemFieldOptions(block.systemKey, current).map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </Field>
          {err(inputName) && <p id={errorId(inputName)} className="mt-1 text-xs text-critical">{err(inputName)}</p>}
        </div>
      );
    }
    case "date": case "email": case "tel": case "text": default: {
      // "name" is special: two inputs (first + last).
      if (block.systemKey === "name") {
        return (
          <div className="space-y-4">
            <div>
              <Field label="First name" required><Input name="firstName" defaultValue={prefill.firstName} required {...errorProps("firstName")} /></Field>
              {err("firstName") && <p id={errorId("firstName")} className="mt-1 text-xs text-critical">{err("firstName")}</p>}
            </div>
            <div>
              <Field label="Last name" required><Input name="lastName" defaultValue={prefill.lastName} required {...errorProps("lastName")} /></Field>
              {err("lastName") && <p id={errorId("lastName")} className="mt-1 text-xs text-critical">{err("lastName")}</p>}
            </div>
          </div>
        );
      }
      if (block.systemKey === "initials") {
        return (
          <SignaturePad
            name="sig__initials"
            label={label}
            required
            helpText={block.helpText}
            personName={`${prefill.firstName} ${prefill.lastName}`.trim()}
            error={err("sig__initials")}
          />
        );
      }
      const nameByKey: Record<string, string> = { email: "email", netId: "netId", phone: "phone", dob: "dateOfBirth", dietary: "dietaryRestrictions" };
      const type = spec.render === "text" ? "text" : spec.render;
      const defaults: Record<string, string> = {
        email: prefill.email,
        netId: prefill.netId,
        phone: prefill.phone,
      };
      const required = block.systemKey === "email";
      const inputName = nameByKey[block.systemKey];
      return (
        <div>
          <Field label={label} required={required}><Input name={inputName} type={type} defaultValue={defaults[block.systemKey]} required={required} {...errorProps(inputName)} /></Field>
          {err(inputName) && <p id={errorId(inputName)} className="mt-1 text-xs text-critical">{err(inputName)}</p>}
        </div>
      );
    }
  }
}
