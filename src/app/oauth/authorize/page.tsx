import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { auth } from "@/platform/auth/auth";
import { requirePersonSession } from "@/platform/auth/session";
import { loginRedirectPath } from "@/platform/auth/safe-next";
import { can } from "@/platform/rbac/engine";
import { clientRedirect, validateAuthorizeRequest, type AuthorizeParams } from "@/platform/oauth/authorize";
import { isLoopback, type ResolvedClient } from "@/platform/oauth/client";
import { publicOrigin } from "@/platform/oauth/origin";
import { HavenLogo } from "@/platform/ui/haven-logo";
import { Button } from "@/platform/ui/button";
import { TextLink } from "@/platform/ui/text-link";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { approveAuthorizationAction, denyAuthorizationAction } from "./actions";

export function generateMetadata() {
  return buildPageMetadata({ title: "Connect an app" });
}

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | null {
  return (Array.isArray(v) ? v[0] : v) ?? null;
}

/**
 * The OAuth consent screen: where a person lets an MCP client read Hub data as
 * them. Any client can ask, so this screen is the real gate: it states what
 * the app claims to be, where access is actually sent, and asks the person to
 * continue only if they started the connection themselves.
 *
 * Lives outside the (app) group on purpose. It is reached in a popup from the
 * client, mid-task, so it should look like the login page it follows
 * rather than drop the person into the full app shell. It still requires a
 * real Hub session (requirePersonSession, including the onboarding gate), so
 * nothing about being outside (app) loosens who can reach it.
 *
 * Signing in first is handled HERE rather than by requirePersonSession,
 * because that helper's login bounce preserves only the path (see
 * loginRedirectPath) and every parameter of an authorization request is in
 * the query string. Losing it would land the person on a consent screen with
 * nothing to consent to.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  if (first(sp.invalid)) return <Frame><Problem message="This connection request is no longer valid. Start again from the app you were connecting." /></Frame>;

  const params: AuthorizeParams = {
    response_type: first(sp.response_type),
    client_id: first(sp.client_id),
    redirect_uri: first(sp.redirect_uri),
    code_challenge: first(sp.code_challenge),
    code_challenge_method: first(sp.code_challenge_method),
    state: first(sp.state),
    scope: first(sp.scope),
    resource: first(sp.resource),
  };
  const origin = publicOrigin(await headers());
  const outcome = await validateAuthorizeRequest(params, origin);

  if (outcome.kind === "fatal") return <Frame><Problem message={outcome.message} /></Frame>;
  if (outcome.kind === "redirect_error") {
    redirect(
      clientRedirect(
        outcome.redirectUri,
        { error: outcome.error, error_description: outcome.description, state: outcome.state },
        origin,
      ),
    );
  }

  const session = await auth();
  if (!session) {
    const query = new URLSearchParams(
      Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
    redirect(loginRedirectPath(`/oauth/authorize?${query.toString()}`));
  }
  const person = await requirePersonSession();

  const appLabel = describeApp(outcome.client);

  if (!(await can(person.personId, outcome.resource.permission))) {
    const back = clientRedirect(outcome.redirectUri, { error: "access_denied", state: outcome.state }, origin);
    return (
      <Frame>
        <h1 className="mt-5 text-center text-xl font-bold tracking-tight text-foreground">You can&apos;t connect this yet</h1>
        <p className="mt-3 text-sm text-foreground-soft">
          Connecting an app to {outcome.resource.title} needs to be switched on for your account by a Hub
          administrator. Ask them to grant it, then try connecting again.
        </p>
        <p className="mt-6 text-center text-sm">
          <TextLink href={back}>Return to the app</TextLink>
        </p>
      </Frame>
    );
  }

  const local = isLoopback(new URL(outcome.redirectUri).hostname);
  const nativeScheme = !/^https?:$/.test(new URL(outcome.redirectUri).protocol);
  const hidden = Object.entries(params).map(([k, v]) => <input key={k} type="hidden" name={k} value={v ?? ""} />);

  return (
    <Frame>
      <h1 className="mt-5 text-center text-xl font-bold tracking-tight text-foreground">Connect an app to the Hub</h1>
      <p className="mt-2 text-center text-sm text-foreground-soft">Signed in as {person.name}</p>

      <div className="mt-6 space-y-3 text-sm text-foreground-soft">
        <p>
          {appLabel} wants to read {outcome.resource.title} as you. It would see exactly what you can see in the
          Hub, and could not change anything.
        </p>
        <p>
          Access is sent to <strong className="text-foreground">{outcome.redirectHost}</strong>.{" "}
          {local
            ? "That is an app running on this computer."
            : nativeScheme
              ? "That is an app installed on this device."
              : "That is a website."}{" "}
          Only continue if you started this connection yourself, just now, from an app you trust.
        </p>
        <p>Uploaded files, signatures, and onboarding paperwork are never shared.</p>
        <p>
          You can disconnect at any time from <TextLink href="/my-info/connections">Connected apps</TextLink>.
        </p>
      </div>

      <div className="mt-8 flex gap-3">
        <form action={denyAuthorizationAction} className="flex-1">
          {hidden}
          <Button type="submit" variant="outline" className="w-full">Cancel</Button>
        </form>
        <form action={approveAuthorizationAction} className="flex-1">
          {hidden}
          <Button type="submit" className="w-full">Allow</Button>
        </form>
      </div>
    </Frame>
  );
}

/**
 * How the asking app is named on the consent screen. Its own name is
 * self-asserted -- anyone can register as "Claude" -- so it is always shown as
 * a claim, next to the one thing that IS verified: for a metadata-document
 * client, the host its document was fetched from.
 */
function describeApp(client: ResolvedClient): ReactNode {
  const name = client.clientName ? <strong className="text-foreground">&ldquo;{client.clientName}&rdquo;</strong> : null;
  if (client.kind === "metadata-document") {
    return (
      <>
        An app from <strong className="text-foreground">{client.documentHost}</strong>
        {name ? <> calling itself {name}</> : null}
      </>
    );
  }
  return name ? <>An app calling itself {name} (name not verified)</> : <>An unnamed app</>;
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <div className="glass-panel w-full max-w-md rounded-2xl p-8 shadow-xl">
        <HavenLogo className="mx-auto h-12 text-brand-fg" />
        {children}
      </div>
    </div>
  );
}

function Problem({ message }: { message: string }) {
  return (
    <>
      <h1 className="mt-5 text-center text-xl font-bold tracking-tight text-foreground">Can&apos;t connect</h1>
      <p role="alert" className="mt-3 text-center text-sm text-foreground-soft">{message}</p>
    </>
  );
}
