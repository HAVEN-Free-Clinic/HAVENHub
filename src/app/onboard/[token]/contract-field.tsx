"use client";
import { useState } from "react";
import type { EpicRequirement, Track } from "@prisma/client";
import { Input, Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";
import { SignaturePad } from "@/platform/ui/signature-pad";
import { FieldPreview } from "@/modules/recruitment/components/field-preview";
import { Prose } from "@/modules/recruitment/contract/prose";
import { AVAILABILITY_CHANGE_OPTIONS, SYSTEM_FIELDS, isSystemFieldRequired, systemFieldOptions } from "@/modules/recruitment/contract/system-fields";
import type { ContractBlock } from "@/modules/recruitment/contract/layout";
import { UploadSizeField } from "@/platform/ui/upload-size-field";
import { ProfilePhotoField } from "./photo-field";

// todayIso is stamped once on the server and passed down, so the HIPAA date
// bounds are identical between the server render and client hydration (a
// render-body new Date() would differ across the request/hydration boundary).
// department/track/epicRequirement are the same authoritative context
// buildContractAnswers uses, so client-side visibility (visibleContractBlocks,
// in onboard-form.tsx) matches what the server will validate.
type Ctx = {
  firstName: string; orgName: string; todayIso: string;
  trainingDate: string; trainingLocation: string;
  department: string | null; track: Track; epicRequirement: EpicRequirement;
  storedEpicId: string | null;
  /** The clinic dates the applicant chose on their application, already
   *  labelled, for the availability check. Resolved on the server so the list
   *  hydrates identically. The live page always supplies it; a render without
   *  it (the builder preview of a global template) shows the empty state. */
  applicationAvailability?: string[];
  /** A HIPAA certificate already on file that covers the term, dates formatted
   *  on the server. When set, the upload becomes optional. */
  hipaaOnFile?: { completionDate: string; expiresAt: string; pendingVerification: boolean } | null;
  /** The person's stored profile photo as a data URI. When set, a new photo is optional. */
  photoOnFile?: string | null;
};
type Prefill = { firstName: string; legalMiddleName?: string; lastName: string; preferredFirstName: string; email: string; netId: string; phone: string; pronouns?: string; yaleAffiliation: string; gradYear: string; staffTitle?: string };

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

// systemFieldOptions (in system-fields.ts) supplies the choice list and
// prepends any stored value the canonical list does not know, so a prefill
// outside the list still renders selected instead of silently blanking out.

/**
 * The availability check. Shows the clinic dates the applicant chose on their
 * application and asks whether any of them need to change. A change is a
 * REQUEST: it is stored on the contract for the department's directors to read
 * in the schedule builder, and nothing applies it to the schedule, so the copy
 * says so before they write one.
 *
 * Neither answer feeds the visibility answers map (no onAnswer) and the server
 * leaves both out of its map too, so no block can gate on them and client and
 * server stay in agreement. The follow-up is revealed by local state and
 * required server-side whenever the submitted answer is "yes".
 */
function AvailabilityChangeField({
  label, dates, err, required,
}: {
  label: string;
  dates: string[];
  err: (k: string) => string | undefined;
  /** Whether the yes/no must be answered. The explanation is required after a "yes" either way. */
  required: boolean;
}) {
  const [needed, setNeeded] = useState("");
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-foreground">{label}</p>
      {dates.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-sm text-foreground-soft">
            On your application, you said you can volunteer on these clinic dates:
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {dates.map((d) => (
              <li key={d} className="rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
                {d}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-foreground-soft">
          We do not have any clinic dates from your application on file.
        </p>
      )}
      <p className="text-sm text-foreground-soft">
        Changes to your availability can only be made by request. If something has changed since you
        applied, request the change below and explain why. Your directors will review it, and your
        schedule does not change until they do.
      </p>
      <FieldPreview
        f={{
          key: "availabilityChangeNeeded",
          label: "Do you need to make any last-minute changes to your availability?",
          helpText: null, type: "SINGLE_SELECT", required,
          options: AVAILABILITY_CHANGE_OPTIONS, validation: null,
        }}
        departments={[]}
        fieldError={err("availabilityChangeNeeded")}
        onValueChange={(_key, value) => setNeeded(typeof value === "string" ? value : "")}
      />
      {needed === "yes" && (
        <FieldPreview
          f={{
            key: "availabilityChangeRequest",
            label: "Which dates need to change, and why?",
            helpText: "List each date, say whether you can no longer make it or can now add it, and explain the reason.",
            type: "LONG_TEXT", required: true, options: null, validation: null,
          }}
          departments={[]}
          fieldError={err("availabilityChangeRequest")}
        />
      )}
    </div>
  );
}

export function ContractField({
  block, prefill, ctx, err, onAnswer, departments = [], maxUploadMb = 4,
}: {
  block: ContractBlock;
  prefill: Prefill;
  ctx: Ctx;
  err: (k: string) => string | undefined;
  onAnswer: (name: string, value: string | string[]) => void;
  // Active department codes, for a custom_question of type DEPARTMENT_CHOICE
  // (e.g. the director default's second_department_name). Defaults to [] so
  // existing callers that never render a DEPARTMENT_CHOICE block keep
  // typechecking; the real onboard page always supplies the loaded list.
  departments?: string[];
  /**
   * The `uploads.maxMb` setting, mirrored into the browser so an oversized
   * HIPAA certificate is refused before it is posted. Defaults to 4 -- the cap
   * settings/registry.ts enforces -- so a test rendering this block in
   * isolation still gets a real limit rather than an unbounded one.
   */
  maxUploadMb?: number;
}) {
  const [hasEpic, setHasEpic] = useState(false);

  // Field owns this for every control it wraps: it shows the message, ties it to
  // the control (aria-invalid + aria-describedby) AND announces it. Only the
  // agreement checkbox below is not inside a Field, so it keeps the wiring by
  // hand -- including the role="alert" the ten hand-rolled copies all lacked,
  // which is why a rejected contract used to re-render in silence.
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
            <Checkbox
              name={`confirm__${block.id}`}
              required
              onChange={(e) => onAnswer(`confirm__${block.id}`, e.target.checked ? "on" : "")}
              {...errorProps(`confirm__${block.id}`)}
              label={renderVars(block.signatureLabel, ctx)}
            />
            {err(`confirm__${block.id}`) && (
              <p id={errorId(`confirm__${block.id}`)} role="alert" className="mt-1 text-xs text-critical-foreground">{err(`confirm__${block.id}`)}</p>
            )}
          </>
        ) : (
          // The title is already the heading above; the pad's own label shows
          // the editable signature prompt ("type your full name", "initial
          // below") so it stays visible next to the box and the builder's
          // "Signature prompt" field is not dead. Mirrors the checkbox branch,
          // which shows signatureLabel beside the checkbox.
          <SignaturePad
            name={`sig__${block.id}`}
            label={renderVars(block.signatureLabel, ctx)}
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
          departments={departments}
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
  const label = renderVars(block.label ?? spec.defaultLabel, ctx);
  switch (spec.render) {
    case "epicBlock":
      // State 1: an Epic ID is already on file for this returning member, so we
      // confirm it rather than re-collect. No inputs.
      if (ctx.storedEpicId) {
        return (
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">{label}</p>
            <p className="text-sm text-foreground-soft">
              Your Epic ID (<span className="font-mono font-medium text-foreground">{ctx.storedEpicId}</span>) is
              already on file. No action needed here.
            </p>
          </div>
        );
      }
      // State 2: no Epic ID on file and the department uses Epic. One question,
      // then collect only what IT needs. The "work with YNHH" checkbox lives
      // here because it only matters when modifying an existing account.
      return (
        <div className="space-y-3">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <Checkbox
            name="hasEpic"
            checked={hasEpic}
            onChange={(e) => { setHasEpic(e.target.checked); onAnswer("hasEpic", e.target.checked ? "on" : ""); }}
            label="I already have a Yale Epic account."
          />
          {hasEpic ? (
            <div className="space-y-2 border-l-2 border-border pl-3">
              <Field
                label="Your Epic ID"
                hint="Enter it in capital letters."
                required
                error={err("existingEpicId")}
              >
                <Input name="existingEpicId" required />
              </Field>
              <Checkbox name="worksWithYnhh" label="I currently work with Yale New Haven Hospital." />
            </div>
          ) : (
            <p className="text-sm text-foreground-soft">
              We will set up your Epic account. Directions follow after you submit this form.
            </p>
          )}
        </div>
      );
    case "hipaaBlock": {
      // Deterministic string math off the server-stamped date -- no new Date() in
      // render, so the bounds hydrate identically. Certificates older than 5 years
      // are not accepted, and completion cannot be in the future.
      const maxHipaa = ctx.todayIso;
      const [ty, tm, td] = ctx.todayIso.split("-");
      const minHipaa = `${Number(ty) - 5}-${tm}-${td}`;
      const instructions = block.helpText ? <Prose text={renderVars(block.helpText, ctx)} /> : null;
      // Required only when no certificate on file covers the term; submitContract
      // applies the same rule. UploadSizeField, not a raw input: over the
      // platform's ~4.5 MB Server Action limit the edge answers the POST itself,
      // so the file has to be refused in the browser.
      const inputs = (required: boolean) => (
        <>
          <Field label="HIPAA completion date" required={required} error={err("hipaaCompletedAt")}>
            <Input name="hipaaCompletedAt" type="date" required={required} min={minHipaa} max={maxHipaa} />
          </Field>
          <Field label="HIPAA certificate (PDF)" required={required} error={err("hipaaFile")}>
            <UploadSizeField
              name="hipaaFile"
              maxMb={maxUploadMb}
              accept="application/pdf,image/*"
              required={required}
            />
          </Field>
        </>
      );
      if (ctx.hipaaOnFile) {
        const { completionDate, expiresAt, pendingVerification } = ctx.hipaaOnFile;
        // Open when the server rejected a half-finished replacement, so the error shows.
        const replacing = Boolean(err("hipaaCompletedAt") || err("hipaaFile"));
        return (
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">{label}</p>
            <p className="text-sm text-foreground-soft">
              {pendingVerification
                ? `We already have the HIPAA certificate you completed on ${completionDate}. It is waiting to be verified, so there is no need to upload it again.`
                : `Your HIPAA certificate, completed on ${completionDate}, is on file and valid through ${expiresAt}, so there is no need to upload it again.`}
            </p>
            <details open={replacing} className="rounded-lg border border-border px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium text-foreground">Upload a newer certificate instead</summary>
              <div className="mt-3 space-y-2">
                {instructions}
                {inputs(false)}
              </div>
            </details>
          </div>
        );
      }
      return (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">{label}</p>
          {instructions}
          {inputs(true)}
        </div>
      );
    }
    case "photoBlock":
      return (
        <ProfilePhotoField
          label={label}
          error={err("photo")}
          maxUploadMb={maxUploadMb}
          currentPhoto={ctx.photoOnFile ?? null}
          required={isSystemFieldRequired(block)}
        />
      );
    case "availabilityBlock":
      return (
        <AvailabilityChangeField
          label={label}
          dates={ctx.applicationAvailability ?? []}
          err={err}
          required={isSystemFieldRequired(block)}
        />
      );
    case "checkbox":
      // "spanish" is no longer emitted by either default layout (the Spanish
      // field was dropped from Prefill along with it), but the system key
      // stays legal for a custom/legacy layout snapshot; render it
      // unprefilled rather than reading a Prefill field that no longer exists.
      return (
        <Checkbox
          name={block.systemKey === "spanish" ? "spanishSelfReported" : "licensedRN"}
          defaultChecked={false}
          label={label}
        />
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
      // Required per the director's choice or the field's default; submitContract
      // reads the same rule.
      const required = isSystemFieldRequired(block);
      return (
        <Field
          label={label}
          hint={block.helpText ? renderVars(block.helpText, ctx) : undefined}
          required={required}
          error={err(inputName)}
        >
          {/* onChange feeds the answers map so a visibleWhen keyed on this
              field (e.g. staffTitle on yaleAffiliation) matches server-side. */}
          <Select
            name={inputName}
            defaultValue={current}
            required={required}
            onChange={(e) => onAnswer(inputName, e.target.value)}
          >
            <option value="">Select…</option>
            {systemFieldOptions(block.systemKey, current).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
        </Field>
      );
    }
    case "date": case "email": case "tel": case "text": default: {
      // "name" is special: the legal parts, then the name they go by. The
      // contract is a signed record and feeds the Epic request, so it asks for
      // the name of record; "Goes by" is what the clinic reads.
      if (block.systemKey === "name") {
        return (
          <div className="space-y-4">
            <Field label="Legal first name" required error={err("firstName")}>
              <Input name="firstName" defaultValue={prefill.firstName} required />
            </Field>
            <Field label="Legal middle name" hint="Optional." error={err("legalMiddleName")}>
              <Input name="legalMiddleName" defaultValue={prefill.legalMiddleName ?? ""} />
            </Field>
            <Field label="Legal last name" required error={err("lastName")}>
              <Input name="lastName" defaultValue={prefill.lastName} required />
            </Field>
            <Field
              label="Goes by"
              hint="Leave blank if your legal first name is what you go by. This is the name we will use on rosters, badges, and email."
              error={err("preferredFirstName")}
            >
              <Input
                name="preferredFirstName"
                defaultValue={prefill.preferredFirstName}
                placeholder={prefill.firstName}
              />
            </Field>
          </div>
        );
      }
      if (block.systemKey === "initials") {
        return (
          <SignaturePad
            name="sig__initials"
            label={label}
            required
            helpText={block.helpText ? renderVars(block.helpText, ctx) : block.helpText}
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
        pronouns: prefill.pronouns ?? "",
        staffTitle: prefill.staffTitle ?? "",
      };
      const required = isSystemFieldRequired(block);
      const inputName = nameByKey[block.systemKey];
      return (
        <Field label={label} required={required} error={err(inputName)}>
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
          />
        </Field>
      );
    }
  }
}
