import { getAccessToken } from "./oauth";
import { getSetting } from "@/platform/settings/service";

/** A single outbound email message. */
export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  /** Override the sending mailbox (Send-As). Defaults to the transport's sender. */
  from?: string;
  /** Optional display name paired with `from`. */
  fromName?: string;
};

/** Minimal contract every transport must satisfy. */
export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

// ---------------------------------------------------------------------------
// LogTransport
// ---------------------------------------------------------------------------

/**
 * Development transport: prints every outbound message to stdout instead of
 * actually sending it. Safe for CI and local dev with no credentials needed.
 */
export class LogTransport implements EmailTransport {
  async send(message: EmailMessage): Promise<void> {
    const from = message.from ?? "(default sender)";
    console.log(`[email] from=${from} to=${message.to} subject=${message.subject}`);
  }
}

// ---------------------------------------------------------------------------
// GraphTransport
// ---------------------------------------------------------------------------

interface GraphTransportOpts {
  /** Returns a valid Graph access token (delegated). Defaults to the oauth.ts getAccessToken. */
  getAccessToken: () => Promise<string>;
  /** The mailbox to send AS (the shared mailbox, e.g. hfc.it@yale.edu). */
  sender: string;
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Production transport: sends mail via the Microsoft Graph API using a
 * delegated OAuth token obtained from oauth.ts. The transport never retries --
 * the outbox queue layer handles back-off and retry.
 */
export class GraphTransport implements EmailTransport {
  private readonly getToken: () => Promise<string>;
  private readonly sender: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GraphTransportOpts) {
    this.getToken = opts.getAccessToken;
    this.sender = opts.sender;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(message: EmailMessage): Promise<void> {
    const token = await this.getToken();
    const sender = message.from?.trim() || this.sender;
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`;

    const graphMessage: Record<string, unknown> = {
      subject: message.subject,
      body: { contentType: "HTML", content: message.html },
      toRecipients: [{ emailAddress: { address: message.to } }],
    };
    // A display name requires an explicit from block; without one the mailbox's
    // own configured display name is used.
    if (message.fromName && message.fromName.trim()) {
      graphMessage.from = {
        emailAddress: { address: sender, name: message.fromName.trim() },
      };
    }

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: graphMessage, saveToSentItems: true }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Graph sendMail failed: ${res.status} ${text}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Resolve the email transport from admin settings (DB override -> env default).
 */
export async function resolveEmailTransport(): Promise<EmailTransport> {
  const transport = await getSetting<"log" | "graph">("email.transport");
  if (transport === "graph") {
    const sender = await getSetting<string>("email.sender");
    // Defensive: the write guard blocks enabling graph without a sender, but a
    // later reset of email.sender could leave graph active with no sender. Fall
    // back to the log transport (with a warning) rather than build a malformed
    // Graph request that fails opaquely at send time.
    if (!sender) {
      console.warn(
        "[email] transport is graph but no sender is configured; falling back to log transport"
      );
      return new LogTransport();
    }
    return new GraphTransport({ getAccessToken, sender });
  }
  return new LogTransport();
}
