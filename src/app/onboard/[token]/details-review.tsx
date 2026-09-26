"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import posthog from "posthog-js";
import { Button } from "@/platform/ui/button";
import type { ContractBlock, SystemFieldBlock } from "@/modules/recruitment/contract/layout";
import { systemFieldOptions, isSystemFieldRequired } from "@/modules/recruitment/contract/system-fields";
import { legalNameOf } from "@/platform/person-name";
import { formatPhone } from "@/platform/phone";

/** Details the application already collected, shown for review rather than asked again. */
const REVIEWABLE = new Set<string>(["name", "email", "netId", "phone", "pronouns", "yaleAffiliation", "gradYear", "staffTitle"]);

export function isReviewableBlock(block: ContractBlock): block is SystemFieldBlock {
  return block.kind === "system_field" && REVIEWABLE.has(block.systemKey);
}

/** The input names each reviewable block posts, so a server error on one of them opens the inputs. */
const INPUT_NAMES: Record<string, string[]> = {
  name: ["firstName", "legalMiddleName", "lastName", "preferredFirstName"],
  email: ["email"], netId: ["netId"], phone: ["phone"], pronouns: ["pronouns"],
  yaleAffiliation: ["yaleAffiliation"], gradYear: ["gradYear"], staffTitle: ["staffTitle"],
};

/**
 * The prefill values a reviewable block needs before its inputs may stay hidden.
 *
 * A control rendered `required` inside the summary's `hidden` wrapper is one the
 * browser refuses to submit AND cannot focus to say why, so pressing "Submit
 * onboarding" does nothing at all with no message anywhere on the page. Any
 * required detail the application did not collect therefore has to open the
 * inputs, not just the three core ones: the FA26 volunteer template marks
 * yaleAffiliation, gradYear and phone required while 241 of 430 accepted
 * applicants had no affiliation on file, which dead-ended 260 of them.
 *
 * `name` and `email` are core, so isSystemFieldRequired always returns true for
 * them and the original first/last/email rule is preserved exactly.
 */
const REQUIRED_PREFILL: Record<string, (p: ReviewPrefill) => (string | undefined)[]> = {
  name: (p) => [p.firstName, p.lastName],
  email: (p) => [p.email],
  netId: (p) => [p.netId],
  phone: (p) => [p.phone],
  pronouns: (p) => [p.pronouns],
  yaleAffiliation: (p) => [p.yaleAffiliation],
  gradYear: (p) => [p.gradYear],
  staffTitle: (p) => [p.staffTitle],
};

/** Short labels for the summary. The form's own labels are questions, some a sentence long. */
const SUMMARY_LABEL: Record<string, string> = {
  email: "Email", netId: "NetID", phone: "Phone", pronouns: "Pronouns",
  yaleAffiliation: "Yale affiliation", gradYear: "Graduation year", staffTitle: "Staff title",
};

export type ReviewPrefill = {
  firstName: string; legalMiddleName?: string; lastName: string; preferredFirstName: string;
  email: string; netId: string; phone: string; pronouns?: string;
  yaleAffiliation: string; gradYear: string; staffTitle?: string;
};

function optionLabel(key: "yaleAffiliation" | "gradYear", value: string): string {
  return systemFieldOptions(key, value).find((o) => o.value === value)?.label ?? value;
}

/** The label and value rows the summary shows, in block order. Blank values are null. */
export function reviewRows(blocks: SystemFieldBlock[], prefill: ReviewPrefill): { label: string; value: string | null }[] {
  const rows: { label: string; value: string | null }[] = [];
  const text = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
  for (const b of blocks) {
    switch (b.systemKey) {
      case "name": {
        const legal = legalNameOf({ legalFirstName: prefill.firstName, legalMiddleName: text(prefill.legalMiddleName), lastName: prefill.lastName });
        rows.push({ label: "Legal name", value: legal || null });
        if (text(prefill.preferredFirstName)) rows.push({ label: "Goes by", value: text(prefill.preferredFirstName) });
        break;
      }
      case "phone":
        rows.push({ label: SUMMARY_LABEL.phone, value: formatPhone(prefill.phone) });
        break;
      case "yaleAffiliation":
      case "gradYear": {
        const v = text(prefill[b.systemKey]);
        rows.push({ label: SUMMARY_LABEL[b.systemKey], value: v ? optionLabel(b.systemKey, v) : null });
        break;
      }
      case "email": case "netId": case "pronouns": case "staffTitle":
        rows.push({ label: SUMMARY_LABEL[b.systemKey], value: text(prefill[b.systemKey]) });
        break;
    }
  }
  return rows;
}

/**
 * The details the application already collected, as a summary with an "Update"
 * option instead of a page of prefilled inputs to re-read.
 *
 * Blocks split in two. Anything already on file is SUMMARIZED: its inputs render
 * inside the hidden wrapper so the values still post and client-side visibility
 * is computed exactly as before. A required detail the application never
 * collected is MISSING, and is asked as an ordinary visible field below the
 * summary instead.
 *
 * That split is the point: `required` on a control inside `hidden` is one the
 * browser refuses to submit AND cannot focus to explain, so "Submit onboarding"
 * silently does nothing with no message anywhere on the page. It dead-ended 260
 * of 430 FA26 contracts, whose template marks yaleAffiliation/gradYear/phone
 * required while 241 applicants had no affiliation on file. Asking only the
 * blank ones keeps `required` on a control the browser can focus, without
 * exposing the fields the applicant never needed to touch.
 */
export function DetailsReview({
  blocks, prefill, err, renderField,
}: {
  blocks: SystemFieldBlock[];
  prefill: ReviewPrefill;
  err: (k: string) => string | undefined;
  /** Renders one reviewable block's real inputs. Called once per block, either
   *  inside the hidden wrapper (summarized) or in the visible list (missing). */
  renderField: (block: SystemFieldBlock) => ReactNode;
}) {
  const isMissing = (b: SystemFieldBlock) =>
    isSystemFieldRequired(b) &&
    (REQUIRED_PREFILL[b.systemKey]?.(prefill) ?? []).some((v) => !(v ?? "").trim());
  const missing = blocks.filter(isMissing);
  const summarized = blocks.filter((b) => !isMissing(b));

  // Only the summarized inputs can be hidden, so only their errors need to open
  // the wrapper; a missing field is on screen already, with its error beside it.
  const hasError = summarized.some((b) => (INPUT_NAMES[b.systemKey] ?? []).some((name) => err(name)));
  const [editing, setEditing] = useState(false);
  const open = editing || hasError;
  const hasSummary = summarized.length > 0;

  // The button that opened the inputs disappears, so move focus to the first of
  // them rather than dropping it on the page.
  const inputsRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef(false);
  // Set when the browser refused a submit over one of the hidden inputs: the
  // control to focus and explain once the wrapper is open.
  const refusedControl = useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const refused = refusedControl.current;
    if (refused) {
      refusedControl.current = null;
      refused.focus();
      refused.reportValidity();
      return;
    }
    if (!focusOnOpen.current) return;
    focusOnOpen.current = false;
    inputsRef.current?.querySelector<HTMLElement>("input, select, textarea")?.focus();
  }, [open]);

  // A net under the silent dead end #910 removed. If a control the browser
  // cannot focus -- one inside the collapsed wrapper -- ever fails constraint
  // validation again, the browser aborts "Submit onboarding" with no message and
  // never runs onSubmit, so the applicant presses a button that does nothing and
  // nothing is recorded. Instead: open the wrapper, focus the refused control,
  // let the browser say what is wrong, and record it so a regression is visible.
  // `invalid` does not bubble, so this listens in the capture phase.
  useEffect(() => {
    const wrapper = inputsRef.current;
    if (!wrapper) return;
    const onInvalid = (e: Event) => {
      if (!wrapper.hidden) return;
      const control = e.target;
      if (
        !(control instanceof HTMLInputElement ||
          control instanceof HTMLSelectElement ||
          control instanceof HTMLTextAreaElement)
      ) return;
      e.preventDefault();
      // Every refusal of one submit fires synchronously; keep the first, which
      // is the one the browser would have focused.
      if (refusedControl.current) return;
      refusedControl.current = control;
      posthog.capture("onboarding_submit_blocked", { field: control.name || "(unnamed)", hidden: true });
      setEditing(true);
    };
    wrapper.addEventListener("invalid", onInvalid, true);
    return () => wrapper.removeEventListener("invalid", onInvalid, true);
  }, [hasSummary]);

  return (
    <div className="space-y-6">
      {summarized.length > 0 && (
        <>
          {!open && (
            <div className="rounded-lg border border-border bg-muted/40 p-4">
              <p className="text-sm text-foreground-soft">
                We have these details from your application. Check them, and update anything that has changed.
              </p>
              <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr] sm:gap-y-2">
                {reviewRows(summarized, prefill).map(({ label, value }) => (
                  <Fragment key={label}>
                    <dt className="text-xs text-subtle-foreground sm:pt-0.5">{label}</dt>
                    <dd className="mb-2 break-words text-sm text-foreground [overflow-wrap:anywhere] sm:mb-0">
                      {value ?? <span className="italic text-subtle-foreground">Not provided</span>}
                    </dd>
                  </Fragment>
                ))}
              </dl>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => {
                  focusOnOpen.current = true;
                  setEditing(true);
                }}
              >
                Update my details
              </Button>
            </div>
          )}
          <div ref={inputsRef} hidden={!open} className="space-y-6">
            {summarized.map(renderField)}
          </div>
        </>
      )}

      {missing.length > 0 && (
        <div className="space-y-6">
          <p className="text-sm text-foreground-soft">
            {missing.length === 1
              ? "Your application did not include this detail, so please add it here."
              : "Your application did not include these details, so please add them here."}
          </p>
          {missing.map(renderField)}
        </div>
      )}
    </div>
  );
}
