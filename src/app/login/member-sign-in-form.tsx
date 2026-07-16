"use client";
import { useState } from "react";
import { requestMemberLoginLinkAction } from "./login-actions";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";

export function MemberSignInForm({ callbackUrl }: { callbackUrl: string }) {
  const [state, setState] = useState<"idle" | "sent" | "invalid" | "use-yale" | "error">("idle");
  const [pending, setPending] = useState(false);

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

  if (state === "sent") {
    return (
      <Alert tone="success">
        If that email belongs to an active member, we have sent a sign-in link. It expires in 30 minutes.
      </Alert>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      {state === "invalid" && <Alert tone="error">Enter a valid email address.</Alert>}
      {state === "use-yale" && (
        <Alert tone="warning">That is a Yale email. Use &ldquo;Sign in with Yale&rdquo; above.</Alert>
      )}
      {state === "error" && <Alert tone="error">Something went wrong. Please try again.</Alert>}
      <Field label="Email">
        <Input id="member-email" name="email" type="email" required placeholder="you@example.com" />
      </Field>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Sending…" : "Email me a sign-in link"}
      </Button>
    </form>
  );
}
