"use client";

import { useState } from "react";
import { Button } from "@/platform/ui/button";
import { Field, Input } from "@/platform/ui/input";
import { Modal } from "@/platform/ui/modal";
import { ViewSwap } from "@/platform/ui/morph";
import { useToast } from "@/platform/ui/toast/toast";

const STEPS = [
  { key: "welcome", title: "Welcome", body: "A short first step. Continue and watch the panel grow to fit the next one." },
  {
    key: "details",
    title: "Your details",
    body: "A taller step, with a field. Focus lands in it after the swap, so a keyboard user is never left on a control that just left.",
  },
  { key: "done", title: "All set", body: "Back slides content right; Continue slides it left. The dialog never closes between steps." },
] as const;

/** The multi-step pattern: one Modal, a ViewSwap inside it, height morphing to each step. */
export function MorphDialogDemo() {
  const [open, setOpen] = useState(false);
  // Step and direction in ONE state object, updated together (see ViewSwap).
  const [nav, setNav] = useState<{ index: number; direction: 1 | -1 }>({ index: 0, direction: 1 });
  const step = STEPS[nav.index];
  const go = (index: number) => setNav({ index, direction: index < nav.index ? -1 : 1 });

  return (
    <>
      <Button
        onClick={() => {
          setNav({ index: 0, direction: 1 });
          setOpen(true);
        }}
      >
        Open multi-step dialog
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Step ${nav.index + 1} of ${STEPS.length}`}
        footer={
          <>
            <Button variant="outline" disabled={nav.index === 0} onClick={() => go(nav.index - 1)}>
              Back
            </Button>
            {nav.index < STEPS.length - 1 ? (
              <Button onClick={() => go(nav.index + 1)}>Continue</Button>
            ) : (
              <Button onClick={() => setOpen(false)}>Done</Button>
            )}
          </>
        }
      >
        <ViewSwap viewKey={step.key} direction={nav.direction}>
          <div className="space-y-3">
            <p className="text-base font-semibold text-foreground">{step.title}</p>
            <p className="text-sm text-muted-foreground">{step.body}</p>
            {step.key === "details" && (
              <>
                <Field label="Preferred name">
                  <Input name="demo-name" placeholder="Sam" />
                </Field>
                <Field label="Email" hint="We only use it to send your schedule.">
                  <Input name="demo-email" type="email" placeholder="sam@example.org" />
                </Field>
              </>
            )}
          </div>
        </ViewSwap>
      </Modal>
    </>
  );
}

export function ToastDemo() {
  const toast = useToast();
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => toast({ tone: "success", message: "Saved." })}>
        Success toast
      </Button>
      <Button variant="outline" onClick={() => toast({ tone: "info", message: "Your draft is kept for next time." })}>
        Info toast
      </Button>
      <Button variant="outline" onClick={() => toast({ tone: "error", message: "Something went wrong. Try again." })}>
        Error toast
      </Button>
    </div>
  );
}

export function LoadingButtonDemo() {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      disabled={busy}
      onClick={() => {
        setBusy(true);
        setTimeout(() => setBusy(false), 1500);
      }}
    >
      {busy ? "Saving…" : "Save changes"}
    </Button>
  );
}
