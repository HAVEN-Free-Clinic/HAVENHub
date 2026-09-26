"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { clientRedirect, validateAuthorizeRequest, type AuthorizeParams } from "@/platform/oauth/authorize";
import { publicOrigin } from "@/platform/oauth/origin";
import { markClientUsed } from "@/platform/oauth/registration";
import { createAuthorization } from "@/platform/oauth/tokens";

/**
 * The consent form's two buttons. Top-level actions reading plain hidden
 * fields, never inline closures over the page's props -- the same choice the
 * login page makes for its sign-in button, because an inline action's id moves
 * whenever this file changes and a stale tab would then post into nothing.
 *
 * Both re-run validateAuthorizeRequest from the posted fields. Nothing the
 * form carries is trusted: a person could edit the hidden redirect_uri or
 * client_id in the browser, and the validation is what stops that becoming a
 * code delivered somewhere the client never registered.
 */

const FIELDS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
] as const;

function paramsFrom(formData: FormData): AuthorizeParams {
  const out: AuthorizeParams = {};
  for (const f of FIELDS) {
    const v = formData.get(f);
    out[f] = typeof v === "string" && v !== "" ? v : null;
  }
  return out;
}

async function validated(formData: FormData) {
  const origin = publicOrigin(await headers());
  const outcome = await validateAuthorizeRequest(paramsFrom(formData), origin);
  if (outcome.kind === "fatal") redirect("/oauth/authorize?invalid=1");
  if (outcome.kind === "redirect_error") {
    redirect(
      clientRedirect(
        outcome.redirectUri,
        { error: outcome.error, error_description: outcome.description, state: outcome.state },
        origin,
      ),
    );
  }
  return { outcome, origin };
}

export async function approveAuthorizationAction(formData: FormData): Promise<void> {
  const { outcome, origin } = await validated(formData);
  const person = await requirePersonSession();
  // Re-checked here, not just on render: the permission could have been
  // removed between the page loading and the button being pressed.
  if (!(await can(person.personId, outcome.resource.permission))) {
    redirect(clientRedirect(outcome.redirectUri, { error: "access_denied", state: outcome.state }, origin));
  }
  const { code } = await createAuthorization({
    personId: person.personId,
    clientId: outcome.client.clientId,
    clientName: outcome.client.clientName,
    resource: outcome.resourceUrl,
    scope: outcome.resource.scope,
    redirectUri: outcome.redirectUri,
    codeChallenge: outcome.codeChallenge,
  });
  if (outcome.client.kind === "registered") await markClientUsed(outcome.client.clientId);
  redirect(clientRedirect(outcome.redirectUri, { code, state: outcome.state }, origin));
}

export async function denyAuthorizationAction(formData: FormData): Promise<void> {
  const { outcome, origin } = await validated(formData);
  redirect(clientRedirect(outcome.redirectUri, { error: "access_denied", state: outcome.state }, origin));
}
