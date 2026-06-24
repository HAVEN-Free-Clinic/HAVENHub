// src/platform/notifications/teams-transport.ts
import { getAccessToken, mailConnectionStatus } from "@/platform/email/oauth";
import { getSetting } from "@/platform/settings/service";

/** A single outbound Teams chat message. */
export interface TeamsOutboundMessage {
  /** Recipient Entra user id. */
  recipientUserId: string;
  /** Previously-resolved chat id, or null to create/find the 1:1 chat. */
  chatId: string | null;
  /** Teams-safe HTML body. */
  bodyHtml: string;
}

/** Result of a successful send: the chat id used, so callers can cache it. */
export interface TeamsSendResult {
  chatId: string;
}

/** Minimal contract every Teams transport must satisfy. */
export interface TeamsTransport {
  send(message: TeamsOutboundMessage): Promise<TeamsSendResult>;
}

// ---------------------------------------------------------------------------
// LogTeamsTransport
// ---------------------------------------------------------------------------

/** Dev transport: logs instead of sending. Safe for CI and local dev. */
export class LogTeamsTransport implements TeamsTransport {
  async send(message: TeamsOutboundMessage): Promise<TeamsSendResult> {
    console.log(
      `[teams] to=${message.recipientUserId} body=${message.bodyHtml.slice(0, 80)}`
    );
    return { chatId: message.chatId ?? "log-chat" };
  }
}

// ---------------------------------------------------------------------------
// GraphTeamsTransport
// ---------------------------------------------------------------------------

interface GraphTeamsTransportOpts {
  getAccessToken: () => Promise<string>;
  /** UPN of the connected (authorizing) account that sends the DM. */
  senderUpn: string;
  fetchImpl?: typeof fetch;
}

/**
 * Production transport: sends a 1:1 Teams chat message via Microsoft Graph using
 * the delegated mailer token. Ensures the 1:1 chat exists (Graph returns the
 * existing chat for the same member pair, so POST /chats is effectively
 * idempotent), then posts the message. Never retries -- the queue layer handles
 * back-off and retry.
 */
export class GraphTeamsTransport implements TeamsTransport {
  private readonly getToken: () => Promise<string>;
  private readonly senderUpn: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GraphTeamsTransportOpts) {
    this.getToken = opts.getAccessToken;
    this.senderUpn = opts.senderUpn;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(message: TeamsOutboundMessage): Promise<TeamsSendResult> {
    const token = await this.getToken();
    const chatId = message.chatId ?? (await this.ensureChat(token, message.recipientUserId));

    const url = `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chatId)}/messages`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: { contentType: "html", content: message.bodyHtml } }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Graph send chat message failed: ${res.status} ${text}`);
    }
    return { chatId };
  }

  /** Create (or get) the 1:1 chat between the sender and the recipient. */
  private async ensureChat(token: string, recipientUserId: string): Promise<string> {
    const member = (bind: string) => ({
      "@odata.type": "#microsoft.graph.aadUserConversationMember",
      roles: ["owner"],
      "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${bind}')`,
    });
    const res = await this.fetchImpl("https://graph.microsoft.com/v1.0/chats", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        chatType: "oneOnOne",
        members: [member(this.senderUpn), member(recipientUserId)],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Graph create chat failed: ${res.status} ${text}`);
    }
    const json = (await res.json()) as { id: string };
    return json.id;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Resolve the Teams transport. Reuses the email.transport toggle: when it is
 * "graph" and a mailer account is connected, returns the Graph transport sending
 * AS the connected account; otherwise returns the log transport.
 */
export async function resolveTeamsTransport(): Promise<TeamsTransport> {
  const transport = await getSetting<"log" | "graph">("email.transport");
  if (transport !== "graph") return new LogTeamsTransport();
  const status = await mailConnectionStatus();
  if (!status.connected || !status.account) {
    console.warn("[teams] graph transport selected but no mailer account is connected; using log transport");
    return new LogTeamsTransport();
  }
  return new GraphTeamsTransport({ getAccessToken, senderUpn: status.account });
}
