"use client";

import { useState } from "react";
import { Input, Field } from "@/platform/ui/input";

/**
 * The campaign name, held in state rather than left uncontrolled.
 *
 * Not a style choice. React resets an uncontrolled field to its defaultValue
 * after a form action completes, including one that REFUSED, so a sender who
 * renamed the campaign and then tripped the template validator silently lost
 * the rename while their subject, body and audience tree all survived (those
 * three live in client state already). Caught by driving the real page: the
 * refusal rendered correctly and the name box quietly reverted underneath it.
 *
 * Seeded from the saved name on mount, which is also how it picks up a
 * successful save: that path still redirects, the page tree is replaced, and
 * this remounts with the stored value.
 */
export function CampaignNameField({ initialName }: { initialName: string }) {
  const [name, setName] = useState(initialName);
  return (
    <Field label="Campaign name">
      {/* No `required`. The browser refuses to submit a form whose invalid
          control is inside a hidden tab panel and cannot focus one either, so
          Save silently did nothing from the Audience or Review tab and logged
          "An invalid form control with name='name' is not focusable".
          saveAction validates the name instead, and returns the reason rather
          than navigating away from it. */}
      <Input name="name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
    </Field>
  );
}
