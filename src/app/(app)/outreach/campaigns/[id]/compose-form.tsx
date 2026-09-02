"use client";

import { useActionState } from "react";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "./submit-button";
import type { FormProblems } from "./form-state";

/**
 * The campaign editor's save form, and the only place a rejected save is shown.
 *
 * useActionState rather than a plain `<form action>`, because the whole point
 * is that a refusal has somewhere to land: saveAction returns its problems
 * instead of redirecting with them (see actions.ts), and a plain form action
 * discards whatever it returns. What that buys is not tidier error handling, it
 * is the sender's work. Everything unsaved on this page is client state --
 * TemplateEditor's subject and body, AudienceBuilder's entire audience tree --
 * and a redirect replaces the page tree below AppShell, so redirecting on a
 * mistyped template variable used to throw all of it away and leave a toast
 * about a variable name.
 *
 * The sticky footer lives here rather than being passed in as children so that
 * the problems render next to the button that produced them, wherever the
 * sender is scrolled to.
 */
export function ComposeForm({
  id,
  action,
  children,
}: {
  id: string;
  action: (prevState: FormProblems, formData: FormData) => Promise<FormProblems>;
  children: React.ReactNode;
}) {
  const [state, formAction] = useActionState(action, null);

  return (
    <form id={id} action={formAction} className="space-y-8">
      {children}

      {/* Sticky save footer. Always visible (not tab-gated): Save is the only
          way to persist the sendOncePerPerson toggle in the Timing section,
          which lives under the Review tab, so a sender who flips it there still
          needs Save reachable without switching tabs first. */}
      <div className="sticky bottom-0 -mx-1 space-y-2 border-t border-border bg-surface py-3">
        {state && (
          <Alert tone="error">
            {state.problems.length === 1 ? (
              state.problems[0]
            ) : (
              <ul className="list-disc pl-5">
                {state.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </Alert>
        )}
        <SubmitButton pendingLabel="Saving...">Save</SubmitButton>
      </div>
    </form>
  );
}
