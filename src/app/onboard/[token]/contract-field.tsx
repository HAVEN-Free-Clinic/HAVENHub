"use client";
import { useState } from "react";
import type { EpicRequirement, Track } from "@prisma/client";
import { Input, Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";
import { SignaturePad } from "@/platform/ui/signature-pad";
import { FieldPreview } from "@/modules/recruitment/components/field-preview";
import { Prose } from "@/modules/recruitment/contract/prose";
import { SYSTEM_FIELDS, gradYearOptions } from "@/modules/recruitment/contract/system-fields";
import type { ContractBlock } from "@/modules/recruitment/contract/layout";

// todayIso/currentYear are stamped once on the server and passed down, so the
// HIPAA date bounds and grad-year options are identical between the server
// render and client hydration (a render-body new Date() would differ across
// the request/hydration boundary). department/track/epicRequirement are the
// same authoritative context buildContractAnswers uses, so client-side
// visibility (visibleContractBlocks, in onboard-form.tsx) matches what the
// server will validate.
type Ctx = {
  firstName: string; orgName: string; todayIso: string; currentYear: number;
  trainingDate: string; trainingLocation: string;
  department: string | null; track: Track; epicRequirement: EpicRequirement;
};
type Prefill = { firstName: string; lastName: string; email: string; netId: string; phone: string; yaleAffiliation: string; gradYear: string };

function renderVars(text: string, ctx: Ctx): string {
  // Escaped-text output only; substitutes {{firstName}} / {{orgName}} /
  // {{trainingDate}} / {{trainingLocation}} for preview. Kept deliberately
  // simple to avoid importing server-only render helpers into this client
  // component.
  return text
    .replace(/\{\{\s*firstName\s*\}\}/g, ctx.firstName)
    .replace(/\{\{\s*orgName\s*\}\}/g, ctx.orgName)
    .replace(/\{\{\s*trainingDate\s*\}\}/g, ctx.trainingDate)
    .replace(/\{\{\s*trainingLocation\s*\}\}/g, ctx.trainingLocation);
}

/** Prepends the stored/prefilled value as a selectable option when it is
 *  missing from the generated option list, so a value outside the list still
 *  renders selected instead of silently blanking out. `gradYearOptions` is
 *  only a 7-year rolling window, but a stored gradYear flows verbatim from
 *  the application and the canonical application list runs wider (plus
 *  "other"); this guard keeps that answer visible and selected regardless. */
function withStoredOption(
  options: { value: string; label: string }[],
  stored: string,
): { value: string; label: string }[] {
  if (!stored || options.some((o) => o.value === stored)) return options;
  return [{ value: stored, label: stored }, ...options];
}

export function ContractField({
  block, prefill, ctx, err, onAnswer,
}: {
  block: ContractBlock;
  prefill: Prefill;
  ctx: Ctx;
  err: (k: string) => string | undefined;
  onAnswer: (name: string, value: string | string[]) => void;
}) {
  const [hasEpic, setHasEpic] = useState(false);

  // Tie each field's error message to its control so screen readers announce it
  // on focus and mark the input invalid. errorId derives a stable id per field
  // name; errorProps wires aria-invalid + aria-describedby onto the input.
  const errorId = (name: string) => `${name.replace(/[^\w-]/g, "_")}-error`;
  const errorProps = (name: string): { "aria-invalid": boolean; "aria-describedby"?: string } =>
    err(name) ? { "aria-invalid": true, "aria-describedby": errorId(name) } : { "aria-invalid": false };

  if (block.kind === "section") {
    return (
      <div className="space-y-1 border-t border-border pt-6 first:border-0 first:pt-0">
        <h2 className="text-lg font-semibold text-foreground">{renderVars(block.title, ctx)}</h2>
        {block.body.trim() && <Prose text={renderVars(block.body, ctx)} />}
      </div>
    );
  }

  if (block.kind === "agreement") {
    const kind = block.confirmKind ?? "signature";
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">{renderVars(block.title, ctx)}</p>
        {block.body.trim() && <Prose text={renderVars(block.body, ctx)} />}
        {kind === "checkbox" ? (
          <>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                name={`confirm__${block.id}`}
                required
                onChange={(e) => onAnswer(`confirm__${block.id}`, e.target.checked ? "on" : "")}
                {...errorProps(`confirm__${block.id}`)}
              />
              <span>{renderVars(block.signatureLabel, ctx)}</span>
            </label>
            {err(`confirm__${block.id}`) && (
              <p id={errorId(`confirm__${block.id}`)} className="mt-1 text-xs text-critical">{err(`confirm__${block.id}`)}</p>
            )}
          </>
        ) : (
          <SignaturePad
            name={`sig__${block.id}`}
            label={renderVars(block.title, ctx)}
            required
            personName={`${prefill.firstName} ${prefill.lastName}`.trim()}
            error={err(`sig__${block.id}`)}
          />
        )}
      </div>
    );
  }

  if (block.kind === "custom_question") {
    // FieldPreview is shared with the apply wizard and renders label/helpText
    // as plain text with no {{...}} substitution, so interpolate here first.
    // epic_needed_self's authored label carries {{orgName}}; without this the
    // literal token would leak to signers.
    const label = renderVars(block.label, ctx);
    const helpText = block.helpText ? renderVars(block.helpText, ctx) : null;
    return (
      <div>
        <FieldPreview
          f={{ key: `custom__${block.key}`, label, helpText, type: block.type, required: block.required, options: block.options ?? null, validation: null }}
          departments={[]}
          fieldError={err(`custom__${block.key}`)}
          // Notify by the block's raw key (not the custom__-prefixed submit
          // name) since that is what a later block's visibleWhen addresses
          // (e.g. second_department_name gates on "second_department"). This
          // keeps client-side visibility live as the applicant answers,
          // matching buildContractAnswers/visibleContractBlocks in
          // onboard-form.tsx.
          onValueChange={(_key, value) => onAnswer(block.key, value)}
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
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              name="hasEpic"
              checked={hasEpic}
              onChange={(e) => { setHasEpic(e.target.checked); onAnswer("hasEpic", e.target.checked ? "on" : ""); }}
            />
            <span>I already have an Epic ID</span>
          </label>
          {hasEpic && (
            <>
              <div>
                <Field label="Existing Epic ID" hint="Enter it in capital letters." required>
                  <Input name="existingEpicId" required {...errorProps("existingEpicId")} />
                </Field>
                {err("existingEpicId") && <p id={errorId("existingEpicId")} className="mt-1 text-xs text-critical">{err("existingEpicId")}</p>}
              </div>
              <Field label="What type of access are you requesting?">
                <Select name="epicAccessType" defaultValue="">
                  <option value="">Select one</option>
                  <option value="new">I need a new account. I have never had a Yale Epic account before.</option>
                  <option value="renewal">I need a reactivation, renewal, extension or modification to my existing account.</option>
                </Select>
              </Field>
            </>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="worksWithYnhh" /><span>I currently work with Yale New Haven Hospital</span>
          </label>
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
          {block.helpText && <Prose text={renderVars(block.helpText, ctx)} />}
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
      // "spanish" is no longer emitted by either default layout (the Spanish
      // field was dropped from Prefill along with it), but the system key
      // stays legal for a custom/legacy layout snapshot; render it
      // unprefilled rather than reading a Prefill field that no longer exists.
      return (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            name={block.systemKey === "spanish" ? "spanishSelfReported" : "licensedRN"}
            defaultChecked={false}
          />
          <span>{label}</span>
        </label>
      );
    case "select": {
      const stored = block.systemKey === "gradYear" ? prefill.gradYear
        : block.systemKey === "yaleAffiliation" ? prefill.yaleAffiliation
        : "";
      const generated = block.systemKey === "gradYear" ? gradYearOptions(ctx.currentYear) : (spec.options ?? []);
      const options = withStoredOption(generated, stored);
      const nameByKey: Record<string, string> = { yaleAffiliation: "yaleAffiliation", gradYear: "gradYear" };
      const inputName = nameByKey[block.systemKey];
      const defaults: Record<string, string> = { yaleAffiliation: prefill.yaleAffiliation, gradYear: prefill.gradYear };
      return (
        <div>
          <Field label={label}>
            <Select
              name={inputName}
              defaultValue={defaults[block.systemKey] ?? ""}
              onChange={(e) => onAnswer(inputName, e.target.value)}
              {...errorProps(inputName)}
            >
              <option value="">Select one</option>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
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
      const nameByKey: Record<string, string> = {
        email: "email", netId: "netId", phone: "phone", dob: "dateOfBirth",
        dietary: "dietaryRestrictions", pronouns: "pronouns", staffTitle: "staffTitle",
        epicIdExpiration: "epicIdExpiration",
      };
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
          <Field label={label} required={required}>
            <Input
              name={inputName}
              type={type}
              defaultValue={defaults[block.systemKey]}
              required={required}
              // Uncontrolled (defaultValue), but still reports every keystroke
              // to onAnswer, matching the select/checkbox/custom_question
              // branches above. None of these fields is a visibleWhen
              // controller today, but keeping every field's value available
              // in the answers map is what makes the next one that becomes a
              // controller (staffTitle, netId, etc.) work correctly from the
              // first keystroke instead of silently failing to gate anything.
              onChange={(e) => onAnswer(inputName, e.target.value)}
              {...errorProps(inputName)}
            />
          </Field>
          {err(inputName) && <p id={errorId(inputName)} className="mt-1 text-xs text-critical">{err(inputName)}</p>}
        </div>
      );
    }
  }
}
