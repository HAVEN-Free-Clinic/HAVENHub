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
 * Resolve a sign-in name or email to an Entra object id, or null when the
 * directory has no match.
 *
 * Filters on userPrincipalName OR mail deliberately. Those are the same string
 * in many tenants but demonstrably not uniformly at Yale, and asking for both
 * means the Hub never has to know which one a given account uses.
 *
 * A miss is null, not a throw: "this person is not in the directory" is an
 * expected outcome the caller reports to the ED, not an error.
 */
export async function lookupUserId(
  bind: string,
  deps: GraphChatDeps = {},
): Promise<string | null> {
  const literal = odataLiteral(bind);
  const filter = `userPrincipalName eq '${literal}' or mail eq '${literal}'`;
  const url = `${GRAPH}/users?$filter=${encodeURIComponent(filter)}&$select=id&$top=2`;
  let res: Response;
  try {
    res = await call("user lookup", url, { method: "GET" }, deps);
  } catch (err) {
    // A 404 means no such user, which is a miss rather than a failure. Anything
    // else (401, 403, 429, 5xx, a timeout) is a real problem the caller must see.
    if (err instanceof GraphChatError && err.status === 404) return null;
    throw err;
  }
  const json = (await res.json()) as { value?: { id: string }[] };
  const matches = json.value ?? [];
  // More than one match means the bind is ambiguous, so trust none of them
  // rather than adding a coin-flip person to a twenty-person chat.
  if (matches.length !== 1) return null;
  return matches[0].id ?? null;
}

/**
 * Create the group chat. Atomic: if any member id is invalid Graph rejects the
 * whole call, which is why the caller passes only ids it knows are good and adds
 * the rest with addChatMember afterwards.
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

/** Add one member. Isolated per person so a bad id costs one seat, not the chat. */
export async function addChatMember(
  chatId: string,
  userId: string,
  deps: GraphChatDeps = {},
): Promise<void> {
  await call(
    "add chat member",
    `${GRAPH}/chats/${encodeURIComponent(chatId)}/members`,
    {
      method: "POST",
      body: JSON.stringify({
        "@odata.type": "#microsoft.graph.aadUserConversationMember",
        roles: ["owner"],
        "user@odata.bind": userBind(userId),
      }),
    },
    deps,
  );
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
