"use client";

import { Checkbox } from "@/platform/ui/checkbox";

/**
 * Header "select all" checkbox for the pending Epic-request table.
 *
 * The per-row checkboxes live outside the ticket <form> and associate with it
 * via the HTML `form="ticket-form"` attribute, so they are addressable from
 * anywhere in the document. This control toggles every visible row checkbox
 * that targets the same form. It is intentionally tiny and stateless: it
 * reflects the user's intent onto the rows and lets the rows own their own
 * checked state thereafter.
 */
export function SelectAllCheckbox({ formId }: { formId: string }) {
  function toggleAll(checked: boolean) {
    const boxes = document.querySelectorAll<HTMLInputElement>(
      `input[type="checkbox"][name="requestIds"][form="${formId}"]`,
    );
    boxes.forEach((box) => {
      box.checked = checked;
    });
  }

  return (
    <Checkbox
      aria-label="Select all requests"
      onChange={(e) => toggleAll(e.currentTarget.checked)}
    />
  );
}
