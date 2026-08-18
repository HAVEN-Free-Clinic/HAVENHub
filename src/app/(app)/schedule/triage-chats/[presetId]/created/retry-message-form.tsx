"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "@/platform/ui/submit-button";
import { runAction } from "@/platform/ui/run-action";
import { retryMessageAction } from "../../actions";

/**
 * A client wrapper around retryMessageAction, which returns an ActionResult.
 * A native <form action={...}> requires its action to return void, so a Server
 * Component cannot bind that action to a form directly; this component reads
 * the result the way every other action-backed form in this module does, so a
 * Graph failure on retry (a lapsed reconnect, a rate limit) surfaces instead of
 * silently doing nothing.
 */
export function RetryMessageForm({ triageChatId }: { triageChatId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function onSubmit() {
    const result = await runAction(() => retryMessageAction(triageChatId));
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    // No navigation: refresh the current route so the posted state (and the
    // now-gone retry prompt) reflect the server's revalidated data.
    startTransition(() => router.refresh());
  }

  return (
    <form action={onSubmit} className="space-y-2">
      {error && <Alert tone="error">{error}</Alert>}
      <SubmitButton pendingLabel="Posting...">Post the message</SubmitButton>
    </form>
  );
}
