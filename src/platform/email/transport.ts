import { getAccessToken } from "./oauth";
import { inlineEmailHtml } from "./render/inline";
import { getSetting } from "@/platform/settings/service";
import { log } from "@/platform/logging";

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

/** A send that failed for a transient reason (Graph throttling / temporary
 *  unavailability). The queue must retry these WITHOUT counting them toward a row's
 *  permanent attempt budget, or a routine large blast would march its throttled
 *  tail to FAILED even though nothing was wrong with those recipients. */
export class TransientEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientEmailError";
  }
}

/** Cap a single Graph request so a hung/black-holing endpoint can't consume the
 *  whole function budget (default 300s) and starve the rest of the drain. */
const GRAPH_REQUEST_TIMEOUT_MS = 8000;

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
    log.info(`[email] from=${from} to=${message.to} subject=${message.subject}`);
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

    // Inline the layout's <style> rules and drop the <style> block just before
    // delivery. Gmail clips messages that carry an embedded <style> block behind
    // "[Message clipped] / View entire message" -- even tiny ones. This is the
    // single seam every real send funnels through (queue drain, admin test-send,
    // notification email), so rendered/stored HTML stays untouched. See render/inline.ts.
    const html = inlineEmailHtml(message.html);

    const graphMessage: Record<string, unknown> = {
      subject: message.subject,
      body: { contentType: "HTML", content: html },
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
      signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 429 (throttled) and 503 (service unavailable) are transient: a single shared
      // mailbox throttles at ~30 msg/min, so a large blast WILL hit 429s mid-run.
      // Signal transient so the queue retries without burning the row's permanent
      // attempt budget (see TransientEmailError).
      if (res.status === 429 || res.status === 503) {
        const retryAfter = res.headers.get("retry-after");
        throw new TransientEmailError(
          `Graph sendMail throttled: ${res.status}${retryAfter ? ` retry-after=${retryAfter}` : ""} ${text}`,
        );
      }
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
    // The write guard blocks enabling graph without a sender, but a later reset of
    // email.sender could leave graph active with no sender. In production this must
    // NOT silently fall back to the log transport: LogTransport resolves successfully,
    // so the drain marks every row SENT while delivering nothing (green dashboard,
    // zero delivery, including magic-link logins). Throw so the send fails loudly --
    // rows go FAILED, the admin Failed card lights, and the drain logs it. In dev/CI
    // keep the log fallback so local runs without a sender still work.
    if (!sender) {
      if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") {
        throw new Error(
          "email.transport is 'graph' but email.sender is not configured -- refusing to route mail to the log transport in production (would record undelivered mail as SENT)",
        );
      }
      log.warn(
        "[email] transport is graph but no sender is configured; falling back to log transport",
      );
      return new LogTransport();
    }
    return new GraphTransport({ getAccessToken, sender });
  }
  return new LogTransport();
}
