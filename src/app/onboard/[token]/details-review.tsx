"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/platform/ui/button";
import type { ContractBlock, SystemFieldBlock } from "@/modules/recruitment/contract/layout";
import { systemFieldOptions } from "@/modules/recruitment/contract/system-fields";
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
 * The inputs are always rendered (inside `children`), only hidden, so the values
 * post either way and client-side visibility is computed exactly as before. The
 * inputs open straight away when a required detail is missing, since a hidden
 * required input would block the submit with nothing visible to fix, and when the
 * server rejected one of them, so the error is on screen.
 */
export function DetailsReview({
  blocks, prefill, err, children,
}: {
  blocks: SystemFieldBlock[];
  prefill: ReviewPrefill;
  err: (k: string) => string | undefined;
  children: ReactNode;
}) {
  const missingRequired = !prefill.firstName.trim() || !prefill.lastName.trim() || !prefill.email.trim();
  const hasError = blocks.some((b) => (INPUT_NAMES[b.systemKey] ?? []).some((name) => err(name)));
  const [editing, setEditing] = useState(missingRequired);
  const open = editing || hasError;

  // The button that opened the inputs disappears, so move focus to the first of
  // them rather than dropping it on the page.
  const inputsRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef(false);
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    inputsRef.current?.querySelector<HTMLElement>("input, select, textarea")?.focus();
  }, [open]);

  return (
    <div className="space-y-6">
      {!open && (
        <div className="rounded-lg border border-border bg-muted/40 p-4">
          <p className="text-sm text-foreground-soft">
            We have these details from your application. Check them, and update anything that has changed.
          </p>
          <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr] sm:gap-y-2">
            {reviewRows(blocks, prefill).map(({ label, value }) => (
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
        {children}
      </div>
    </div>
  );
}
