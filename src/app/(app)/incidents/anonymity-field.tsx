"use client";

/**
 * The anonymity checkbox plus the "why" it reveals.
 *
 * Client-side only so the reason field appears the moment the box is ticked,
 * instead of sitting on the form as a question that reads as irrelevant to the
 * majority of reporters who do not want anonymity.
 *
 * The reason is deliberately OPTIONAL. This is a safety-reporting path, and a
 * required justification would add friction exactly where friction stops people
 * reporting. Reviewers get the context when a reporter chooses to give it; the
 * anonymity request itself is honoured either way.
 */

import { useState } from "react";
import { Checkbox } from "@/platform/ui/checkbox";
import { Field, Textarea } from "@/platform/ui/input";

export function AnonymityField() {
  const [anonymous, setAnonymous] = useState(false);

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          name="anonymous"
          checked={anonymous}
          onChange={(e) => setAnonymous(e.target.checked)}
        />{" "}
        Do not share my name with the person I am reporting.
      </label>

      {anonymous && (
        <Field
          label="Why would you like to stay anonymous to this person?"
          hint="Optional, and only seen by the incident reviewers. It helps them judge how to handle the report and whether you need any additional support."
        >
          <Textarea name="anonymousReason" rows={3} />
        </Field>
      )}
    </div>
  );
}
