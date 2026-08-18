/**
 * Microsoft Graph calls for the weekly triage group chats.
 *
 * Same shape as channel-link.ts: injectable fetch and token so tests never touch
 * the network, a bounded timeout on every call, and NO internal retry. Errors
 * carry Graph's response body, which is not decoration: a 403 for a missing
 * scope and a 403 for an account that may not chat with a recipient look
 * identical as a bare status code and have completely different fixes.
 */
import { getAccessToken } from "@/platform/email/oauth";

const GRAPH = "https://graph.microsoft.com/v1.0";

/** Bound every call so one hung request cannot hold a server action open. */
const TIMEOUT_MS = 8000;

export type GraphChatDeps = {
  fetchImpl?: typeof fetch;
  getToken?: () => Promise<string>;
};

export class GraphChatError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(operation: string, status: number, body: string) {
    super(`Graph ${operation} failed: ${status}${body ? ` -- ${body}` : ""}`);
    this.name = "GraphChatError";
    this.status = status;
    this.body = body;
  }
}

/** Read Graph's error body without ever letting that read fail the request. */
async function readErrorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

async function call(
  operation: string,
  url: string,
  init: RequestInit,
  deps: GraphChatDeps,
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = await (deps.getToken ?? getAccessToken)();
  const res = await fetchImpl(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new GraphChatError(operation, res.status, await readErrorBody(res));
  return res;
}

/** OData string literals escape a single quote by doubling it. */
function odataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function userBind(userId: string): string {
  return `${GRAPH}/users('${odataLiteral(userId)}')`;
}

/**
 * The Entra object id of the account whose delegated token we hold.
 *
 * Reads /me rather than filtering the directory for the stored mailbox address.
 * That distinction matters here: this tenant's UPN and mail do not always agree
 * (hfc.admin@yale.edu by mail, hfc.admin@yu.yale.edu by UPN), and /me takes no
 * bind string at all, so there is nothing left to disagree about. It also keeps
 * the app off User.ReadBasic.All, since /me is covered by User.Read.
 */
export async function getSignedInUserId(deps: GraphChatDeps = {}): Promise<string | null> {
  const res = await call(
    "signed-in user lookup",
    `${GRAPH}/me?$select=id`,
    { method: "GET" },
    deps,
  );
  const json = (await res.json()) as { id?: string };
  return json.id ?? null;
}

/**
 * Create the group chat. Atomic: if any member id is invalid Graph rejects the
 * whole call, so the caller passes only ids that came from a real sign-in.
 */
export async function createGroupChat(
  input: { topic: string; memberIds: string[] },
  deps: GraphChatDeps = {},
): Promise<{ chatId: string; webUrl: string }> {
  if (input.memberIds.length === 0) {
    throw new Error("A group chat needs at least one member.");
  }
  const res = await call(
    "create group chat",
    `${GRAPH}/chats`,
    {
      method: "POST",
      body: JSON.stringify({
        chatType: "group",
        topic: input.topic,
        members: input.memberIds.map((id) => ({
          "@odata.type": "#microsoft.graph.aadUserConversationMember",
          roles: ["owner"],
          "user@odata.bind": userBind(id),
        })),
      }),
    },
    deps,
  );
  const json = (await res.json()) as { id: string; webUrl?: string };
  return { chatId: json.id, webUrl: json.webUrl ?? "" };
}


/** Post the opening message. Same call the 1:1 Teams transport already makes. */
export async function postChatMessage(
  chatId: string,
  bodyHtml: string,
  deps: GraphChatDeps = {},
): Promise<void> {
  await call(
    "post chat message",
    `${GRAPH}/chats/${encodeURIComponent(chatId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ body: { contentType: "html", content: bodyHtml } }),
    },
    deps,
  );
}
