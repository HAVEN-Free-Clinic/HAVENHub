import type { AppConfig } from "@/platform/config";

/** A single outbound email message. */
export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
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
    console.log(`[email] to=${message.to} subject=${message.subject}`);
  }
}

// ---------------------------------------------------------------------------
// GraphTransport
// ---------------------------------------------------------------------------

interface GraphTransportOpts {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  sender: string;
  /** Injected fetch implementation; defaults to the global fetch. Used in tests. */
  fetchImpl?: typeof fetch;
}

interface TokenCache {
  token: string;
  expiresAt: number; // ms epoch
}

/**
 * Production transport: sends mail via the Microsoft Graph API using
 * OAuth 2.0 client-credentials flow. Tokens are cached and refreshed
 * 60 seconds before expiry. The transport never retries -- the outbox
 * queue layer (Task 3) handles back-off and retry.
 */
export class GraphTransport implements EmailTransport {
  private readonly opts: GraphTransportOpts;
  private readonly fetchImpl: typeof fetch;
  private tokenCache: TokenCache | null = null;

  constructor(opts: GraphTransportOpts) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async acquireToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && now < this.tokenCache.expiresAt) {
      return this.tokenCache.token;
    }

    const { tenantId, clientId, clientSecret } = this.opts;
    const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
    });

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Graph token request failed with status ${res.status}: ${text}`
      );
    }

    const json = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };

    // Cache the token, expiring 60 seconds early to avoid using stale tokens.
    const expiresAt = Date.now() + (json.expires_in - 60) * 1000;
    this.tokenCache = { token: json.access_token, expiresAt };
    return json.access_token;
  }

  async send(message: EmailMessage): Promise<void> {
    const token = await this.acquireToken();
    const { sender } = this.opts;

    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`;

    const payload = {
      message: {
        subject: message.subject,
        body: {
          contentType: "HTML",
          content: message.html,
        },
        toRecipients: [
          {
            emailAddress: {
              address: message.to,
            },
          },
        ],
      },
      saveToSentItems: true,
    };

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Graph sendMail failed with status ${res.status}: ${text}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Return the appropriate transport based on the validated app config.
 * TODO(task 7c): wire delegated OAuth transport when graph branch is selected.
 */
export function emailTransportFromConfig(config: AppConfig): EmailTransport {
  if (config.EMAIL_TRANSPORT === "graph") {
    // TODO(task 7c): replace with the delegated-OAuth transport once implemented.
    return new LogTransport();
  }
  return new LogTransport();
}
