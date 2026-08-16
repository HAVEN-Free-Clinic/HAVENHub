"use client";
import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { requestMemberLoginLinkAction } from "./login-actions";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";

/**
 * Non-Yale member magic-link request, collapsed behind a disclosure so the
 * Yale SSO button stays the single obvious call to action for the ~95% of
 * people who have a yale.edu account. `defaultOpen` lets the page expand it
 * up front when the user landed here from an expired link, where the error
 * copy points them straight at this form.
 */
export function MemberSignInForm({
  callbackUrl,
  defaultOpen = false,
}: {
  callbackUrl: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [state, setState] = useState<"idle" | "sent" | "invalid" | "use-yale" | "error">("idle");
  const [pending, setPending] = useState(false);
  const panelId = useId();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    try {
      const res = await requestMemberLoginLinkAction(new FormData(e.currentTarget));
      setState(res.status);
    } catch {
      setState("error");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <div className="flex justify-center">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className="gap-1.5 text-xs"
        >
          No yale.edu email?
          <ChevronDown
            aria-hidden
            className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </Button>
      </div>

      <div id={panelId} className={open ? "mt-3" : undefined}>
        {!open ? null : state === "sent" ? (
          <Alert tone="success">
            If that email belongs to an active member, we have sent a sign-in link. It expires in 30
            minutes.
          </Alert>
        ) : (
          <form onSubmit={onSubmit} className="space-y-3">
            <input type="hidden" name="callbackUrl" value={callbackUrl} />
            <p className="text-center text-xs text-muted-foreground">
              Get a one-time sign-in link by email.
            </p>
            {state === "invalid" && <Alert tone="error">Enter a valid email address.</Alert>}
            {state === "use-yale" && (
              <Alert tone="warning">That is a Yale email. Use &ldquo;Sign in with Yale&rdquo; above.</Alert>
            )}
            {state === "error" && <Alert tone="error">Something went wrong. Please try again.</Alert>}
            <Field label="Email">
              <Input
                id="member-email"
                name="memberEmail"
                type="email"
                autoComplete="email"
                required
                placeholder="you@example.com"
              />
            </Field>
            <Button type="submit" disabled={pending} className="w-full">
              {pending ? "Sending…" : "Email me a sign-in link"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
