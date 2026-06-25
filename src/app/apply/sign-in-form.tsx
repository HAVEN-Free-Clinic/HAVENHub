"use client";
import { useState } from "react";
import { requestMagicLinkAction } from "./portal-actions";
import { Input } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";

export function SignInForm() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(false);
    const res = await requestMagicLinkAction(new FormData(e.currentTarget));
    setPending(false);
    if (res.ok) setSent(true); else setError(true);
  }

  if (sent) {
    return <Alert tone="success">Check your email for a link to your application. It expires in 30 minutes.</Alert>;
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <label className="block text-sm font-medium text-foreground" htmlFor="portal-email">Email</label>
      <Input id="portal-email" name="email" type="email" required placeholder="you@yale.edu" />
      {error && <p className="text-xs text-critical">Enter a valid email address.</p>}
      <Button type="submit" disabled={pending}>{pending ? "Sending…" : "Email me a link"}</Button>
    </form>
  );
}
