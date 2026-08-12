"use client";

/**
 * Buttons that drive the already-mounted Intercom Messenger widget (booted by
 * IntercomMessenger in the (app) layout) instead of navigating anywhere.
 * Intercom's own SDK routes users through these calls -- showConversation,
 * showNewMessage -- rather than a URL, so the widget can handle auth and
 * context itself.
 *
 * Only render these when Intercom is actually configured (isIntercomConfigured()
 * at the call site). The underlying SDK call is a silent no-op (a
 * console.warn) against an unbooted widget rather than a thrown error, which
 * would look like a dead button instead of failing loudly -- so the gate has
 * to live at the call site, not here.
 */

import type { ComponentProps, ReactNode } from "react";
import { showConversation, showNewMessage } from "@intercom/messenger-js-sdk";
import { Button } from "@/platform/ui/button";

type SharedProps = Omit<ComponentProps<typeof Button>, "onClick" | "type" | "children">;

/** Opens the Messenger straight into an existing conversation -- a member continuing their own linked ticket. */
export function ContinueConversationButton({
  conversationId,
  children = "Continue in Messenger",
  ...rest
}: SharedProps & { conversationId: string; children?: ReactNode }) {
  return (
    <Button type="button" onClick={() => showConversation(conversationId)} {...rest}>
      {children}
    </Button>
  );
}

/** Opens a fresh composer -- the primary "ask a question" entry point on /support/new. */
export function AskInMessengerButton({
  children = "Ask in Messenger",
  ...rest
}: SharedProps & { children?: ReactNode }) {
  return (
    <Button type="button" onClick={() => showNewMessage("")} {...rest}>
      {children}
    </Button>
  );
}
