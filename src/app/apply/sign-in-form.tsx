"use client";
import { useState } from "react";
import { requestMagicLinkAction } from "./portal-actions";
import { Input, Field } from "@/platform/ui/input";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";

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

  return (
    <form onSubmit={onSubmit}>
      <Card className="space-y-4">
        {next && <input type="hidden" name="next" value={next} />}
        {error && <Alert tone="error">Enter a valid email address.</Alert>}
        <Field label="Email">
          <Input id="portal-email" name="email" type="email" required placeholder="you@yale.edu" />
        </Field>
        <FormActions>
          <SubmitButton disabled={pending}>{pending ? "Sending…" : "Email me a link"}</SubmitButton>
        </FormActions>
      </Card>
    </form>
  );
}
