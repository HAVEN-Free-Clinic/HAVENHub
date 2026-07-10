"use client";
import { useState } from "react";
import { requestMagicLinkAction } from "./portal-actions";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";

export function SignInForm({ next }: { next?: string }) {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(false);
    try {
      const res = await requestMagicLinkAction(new FormData(e.currentTarget));
      if (res.ok) setSent(true); else setError(true);
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return <Alert tone="success">Check your email for a link to your application. It expires in 30 minutes.</Alert>;
  }

  // No enclosing Card: this renders inside the sign-in hero card, and nesting a
  // card inside a card just adds visual noise. The parent owns the surface.
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {next && <input type="hidden" name="next" value={next} />}
      {error && <Alert tone="error">Enter a valid email address.</Alert>}
      <Field label="Email">
        <Input id="portal-email" name="email" type="email" required placeholder="you@example.com" />
      </Field>
      <Button type="submit" size="lg" disabled={pending} className="w-full">
        {pending ? "Sending…" : "Email me a link"}
      </Button>
    </form>
  );
}
