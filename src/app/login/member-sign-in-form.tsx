"use client";
import { useState } from "react";
import { requestMemberLoginLinkAction } from "./login-actions";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";

export function MemberSignInForm({ callbackUrl }: { callbackUrl: string }) {
  const [state, setState] = useState<"idle" | "sent" | "invalid" | "use-yale">("idle");
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    try {
      const res = await requestMemberLoginLinkAction(new FormData(e.currentTarget));
      setState(res.status);
    } catch {
      setState("invalid");
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
      {state === "invalid" && (
        <p className="rounded-xl border border-critical/20 bg-critical/5 px-3 py-2 text-sm text-critical">
          Enter a valid email address.
        </p>
      )}
      {state === "use-yale" && (
        <p className="rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
          That is a Yale email. Use &ldquo;Sign in with Yale&rdquo; above.
        </p>
      )}
      <Field label="Email">
        <Input id="member-email" name="email" type="email" required placeholder="you@example.com" />
      </Field>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Sending…" : "Email me a sign-in link"}
      </Button>
    </form>
  );
}
