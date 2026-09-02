import { getAccessToken } from "./oauth";
import { inlineEmailHtml } from "./render/inline";
import { signingTransportFor, type SigningTransport } from "./sending-domains";
import { config } from "@/platform/config";
import { getSettingUncached } from "@/platform/settings/service";
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

/**
 * Whether a thrown error from token acquisition or the sendMail request is
 * transient (a temporary upstream problem that should be retried without burning
 * the row's permanent attempt budget). Covers:
 *   - the 8s AbortSignal.timeout on either fetch (DOMException "TimeoutError")
 *     and a manual abort ("AbortError"),
 *   - network-level fetch rejections (undici throws a TypeError "fetch failed"),
 *   - a 429 or 5xx from the Entra token endpoint (oauth.ts throws
 *     `Error("OAuth ... failed with status <n>")`).
 * MailNotConnectedError and 4xx (other than 429) stay permanent: those need an
 * operator to reconnect or fix the request, and retrying wastes the budget.
 */
export function isTransientSendCause(err: unknown): boolean {
  if (err instanceof TransientEmailError) return true;
  if (!(err instanceof Error)) return false;
  if (err.name === "MailNotConnectedError") return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  if (err.name === "TypeError") return true; // fetch network failure
  const m = err.message.match(/status (\d{3})/);
  if (m) {
    const status = Number(m[1]);
    return status === 429 || status >= 500;
  }
  return false;
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

/**
 * A transport that refuses, per message, because the configured one is unusable.
 *
 * The misconfiguration checks below used to `throw` at RESOLUTION time, and every
 * comment explaining them described a recovery that could therefore never happen:
 * "rows go FAILED, the admin Failed card lights, and the drain logs it". None of
 * that ran. `resolveEmailTransport()` is called by the CALLER, before
 * `drainEmailQueue(transport)`, so the throw escaped before a single row was
 * claimed -- `attempts` never incremented, nothing reached FAILED, and the whole
 * cron tick aborted, taking the Teams drain, the tick log and the heartbeat with
 * it (audit 14, EMAIL-1 / NOTIF-1).
 *
 * Returning this instead puts the failure exactly where the comments always said
 * it was: inside the per-row loop, where the existing attempt budget, FAILED
 * accounting and (for Teams) email fallback already work.
 */
export class UnconfiguredTransport implements EmailTransport {
  constructor(private readonly reason: string) {}
  async send(): Promise<void> {
    throw new Error(this.reason);
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
    // A 429/5xx/timeout/network failure from the Entra token endpoint is transient:
    // the recipient is fine, so retry rather than burn the row's attempt budget.
    let token: string;
    try {
      token = await this.getToken();
    } catch (err) {
      if (isTransientSendCause(err)) {
        throw new TransientEmailError(`Graph token acquisition failed transiently: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw err;
    }
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

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: graphMessage, saveToSentItems: true }),
        signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // The request itself failed to complete: the 8s timeout fired, or the
      // network dropped. Both are transient; the recipient row is untouched.
      if (isTransientSendCause(err)) {
        throw new TransientEmailError(`Graph sendMail request failed transiently: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 429 (throttled) and any 5xx (service unavailable / gateway) are transient:
      // a single shared mailbox throttles at ~30 msg/min, so a large blast WILL hit
      // 429s mid-run, and a Graph 500/502/503/504 is an upstream blip, not a bad
      // recipient. Signal transient so the queue retries without burning the row's
      // permanent attempt budget (see TransientEmailError). 4xx (bad request, auth)
      // stays permanent.
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = res.headers.get("retry-after");
        throw new TransientEmailError(
          `Graph sendMail transient failure: ${res.status}${retryAfter ? ` retry-after=${retryAfter}` : ""} ${text}`,
        );
      }
      throw new Error(`Graph sendMail failed: ${res.status} ${text}`);
    }
  }
}

// ---------------------------------------------------------------------------
// MailerooTransport
// ---------------------------------------------------------------------------

/** POST target for a single transactional send (Maileroo API v2). */
const MAILEROO_SEND_URL = "https://smtp.maileroo.com/api/v2/emails";

/**
 * Recognise Maileroo's two DOMAIN-level rejections and restate them as something
 * an operator can act on, or return null for anything else.
 *
 * Both are configuration states rather than blips, so both are PERMANENT: no
 * amount of retrying re-enables a domain in the Maileroo dashboard or re-scopes
 * a sending key. Classifying either as transient would spend the queue's whole
 * back-off -- 8 attempts spread across minute-ticks, holding the row's claim
 * between them (see drainEmailQueue) -- on something that cannot succeed inside
 * any retry window.
 *
 * They arrive as a 400 today, which the generic 4xx rule below ALREADY treats as
 * permanent. Naming them here does three things that rule cannot: it makes the
 * verdict intentional rather than incidental, it keeps the verdict correct if
 * Maileroo ever answers the same state with a 429 or a 5xx, and it puts the
 * actual fix into EmailLog.lastError instead of a raw API string.
 *
 * The two are kept apart because they call for opposite fixes, and the error
 * text is the only thing that distinguishes them (probed live 2026-08-21; see
 * the maileroo-yale-domain-disabled note):
 *   "...is currently disabled"                    -> that domain IS this sending
 *                                                    key's domain, and it is off
 *   "...is not associated with this sending key"  -> the key belongs to a
 *                                                    DIFFERENT domain
 * Maileroo sending keys are domain-scoped, which is why the second case exists
 * at all and why "check the dashboard" would be the wrong advice for it.
 */
function describeMailerooDomainRejection(text: string): string | null {
  const disabled = /domain\s+['"]([^'"]+)['"]\s+is currently disabled/i.exec(text);
  if (disabled) {
    return (
      `sending domain '${disabled[1]}' is DISABLED in the Maileroo dashboard, so no send from it ` +
      `can be signed. Permanent: re-enable the domain in Maileroo (it needs its DNS records ` +
      `published), or point that domain at another transport in SENDING_DOMAINS.`
    );
  }
  const unassociated = /domain\s+['"]([^'"]+)['"]\s+is not associated with this sending key/i.exec(
    text
  );
  if (unassociated) {
    return (
      `sending domain '${unassociated[1]}' is not associated with this Maileroo sending key. ` +
      `Sending keys are domain-scoped, so MAILEROO_API_KEY belongs to a different domain. ` +
      `Permanent: configure the key for that domain, or point it at another transport in ` +
      `SENDING_DOMAINS.`
    );
  }
  return null;
}

interface MailerooTransportOpts {
  /**
   * The fallback From address, used for every message whose own `from` is on a
   * domain Maileroo cannot sign (and for one that carries no `from` at all).
   * Must itself be on a domain verified in Maileroo. See the class note.
   */
  sender: string;
  /** Sending key from the Maileroo dashboard, sent as the X-API-Key header. */
  apiKey: string;
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Production transport: sends mail via the Maileroo HTTP API.
 *
 * Exists alongside GraphTransport because Graph sends as a Yale shared mailbox
 * and inherits Exchange Online's ~30 messages/minute submission cap, which paces
 * any roster-wide campaign into multi-hour delivery. Maileroo sends from our own
 * verified domain with no comparable per-minute ceiling.
 *
 * SENDER, BY ALLOWLIST: a per-message `from` is honored when SENDING_DOMAINS
 * says Maileroo is the transport that can sign for its domain, and ignored
 * otherwise. Maileroo can only sign mail for a domain verified in our Maileroo
 * account, so honoring an address on any other domain fails the send permanently
 * on an unsignable sending domain.
 *
 * OFF-LIST, the fallback is exactly what this class used to do unconditionally:
 * the message leaves as `this.sender`. That still matters for the two cases that
 * motivated the original pin. The per-template/per-category sender rules (see
 * sender-rules.ts) point at @yale.edu addresses that Yale ITS has not published
 * Maileroo DKIM records for, and yale.edu's own Maileroo entry is registered but
 * DISABLED, so those sends would fail rather than merely look wrong. The
 * fallback also rescues rows enqueued BEFORE the transport switch, whose
 * @yale.edu sender was already snapshotted onto EmailLog.fromEmail at queue time.
 *
 * The pin was written as unconditional because, at the time, every sender rule
 * in play named a domain Maileroo could not sign. It over-reached: it also
 * pinned @havenfreeclinic.org addresses, which Maileroo signs perfectly well, so
 * the address an admin configured never reached the recipient. The allowlist is
 * the same protection stated as the rule it always was.
 *
 * The display name (`fromName`) IS honored either way: it is cosmetic and plays
 * no part in DKIM/SPF alignment, so "HAVEN Recruitment <noreply@...>" stays
 * intact even on a pinned send. An off-list address is not discarded either --
 * it becomes the Reply-To, so replies still reach the human mailbox the sender
 * rule intended. Reply-To is likewise outside DKIM/SPF alignment, so it can
 * safely name an unsignable domain.
 *
 * Yale mail is NOT stranded by the fallback: SigningDomainRouter sends a
 * yale.edu From to Graph, which signs it today, instead of handing it here to be
 * pinned. What changes when Maileroo re-enables yale.edu is one row of
 * SENDING_DOMAINS, not this class.
 *
 * Like GraphTransport this NEVER retries -- the outbox queue owns back-off and
 * the transient/permanent split (see drainEmailQueue).
 */
export class MailerooTransport implements EmailTransport {
  private readonly apiKey: string;
  private readonly sender: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MailerooTransportOpts) {
    this.apiKey = opts.apiKey;
    this.sender = opts.sender;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(message: EmailMessage): Promise<void> {
    const intended = message.from?.trim();
    // The ALLOWLIST decides, not the address itself. signingTransportFor answers
    // "which transport can DKIM-sign for this domain"; only "maileroo" means this
    // send may leave as the address it names. A Graph-signed domain, an unlisted
    // domain and a message with no From all fall back to this.sender, which stays
    // DKIM-aligned with a domain verified in Maileroo. See sending-domains.ts.
    const sender =
      intended && signingTransportFor(intended) === "maileroo" ? intended : this.sender;

    // Same pre-delivery inlining as Graph: Gmail clips messages carrying an
    // embedded <style> block behind "[Message clipped]". Every real send funnels
    // through a transport, so stored/rendered HTML stays untouched.
    const html = inlineEmailHtml(message.html);

    const from: Record<string, string> = { address: sender };
    if (message.fromName && message.fromName.trim()) {
      from.display_name = message.fromName.trim();
    }

    const payload: Record<string, unknown> = {
      from,
      to: [{ address: message.to }],
      subject: message.subject,
      html,
    };

    // Pinning the From would otherwise send every reply into an unattended
    // mailbox. The template's intended sender (the per-template/per-category rule
    // snapshotted onto the row at enqueue) is still the right human destination,
    // so it is preserved as Reply-To. Reply-To is not part of DKIM/SPF alignment,
    // so it can safely name an unsignable domain like @yale.edu.
    //
    // The comparison, not a flag: when the allowlist let this message leave as
    // its own From, `sender` IS `intended` and there is nothing to preserve, so
    // the same condition that has always suppressed a redundant Reply-To covers
    // the on-list case without a second branch.
    if (intended && intended.toLowerCase() !== sender.toLowerCase()) {
      const replyTo: Record<string, string> = { address: intended };
      if (from.display_name) replyTo.display_name = from.display_name;
      payload.reply_to = replyTo;
    }

    let res: Response;
    try {
      res = await this.fetchImpl(MAILEROO_SEND_URL, {
        method: "POST",
        headers: {
          "X-API-Key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // The 8s timeout fired or the network dropped. Transient either way; the
      // recipient row is untouched.
      if (isTransientSendCause(err)) {
        throw new TransientEmailError(
          `Maileroo send request failed transiently: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Checked BEFORE the status rules, so the verdict follows the error text
      // rather than the code Maileroo happened to answer with. See
      // describeMailerooDomainRejection for why both of these must stay permanent.
      const domainRejection = describeMailerooDomainRejection(text);
      if (domainRejection) {
        throw new Error(`Maileroo send failed: ${res.status} ${domainRejection}`);
      }
      // Mirrors the Graph classification: 429 (rate limited) and 5xx are upstream
      // blips, not bad recipients, so retry without burning the attempt budget.
      // 4xx (bad key, unsignable sending domain, malformed address) is permanent.
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = res.headers.get("retry-after");
        throw new TransientEmailError(
          `Maileroo send transient failure: ${res.status}${retryAfter ? ` retry-after=${retryAfter}` : ""} ${text}`,
        );
      }
      throw new Error(`Maileroo send failed: ${res.status} ${text}`);
    }

    // Maileroo answers 200 with an envelope: { success, message, data }. A
    // success:false body on a 200 MUST NOT be treated as delivery -- the queue
    // would stamp the row SENT and never retry, the same silent-undelivered
    // failure resolveEmailTransport refuses to allow for a misconfigured graph
    // sender. An unparseable body is equally unverifiable, so it fails too.
    let body: { success?: boolean; message?: string } | null = null;
    try {
      body = (await res.json()) as { success?: boolean; message?: string };
    } catch {
      throw new Error(`Maileroo send returned ${res.status} with an unparseable body`);
    }
    if (body?.success !== true) {
      // Maileroo spells some rejections this way rather than as a non-2xx, so the
      // same domain-level recognition has to apply here or the diagnosis an
      // operator gets would depend on which shape the API chose.
      const message = body?.message ?? "no message";
      throw new Error(
        `Maileroo send rejected: ${describeMailerooDomainRejection(message) ?? message}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// SigningDomainRouter
// ---------------------------------------------------------------------------

/**
 * Sends each message through the transport that can DKIM-sign for its From
 * domain, falling back to a single default for everything else.
 *
 * This exists because the two domains we send from are signable by DIFFERENT
 * transports (see sending-domains.ts), so an allowlist alone could not make both
 * work: havenfreeclinic.org needs Maileroo, and yale.edu needs Graph until its
 * Maileroo entry is re-enabled. Routing is the only place that difference is
 * acted on; every other layer just reads the map.
 *
 * The router routes and nothing else. It does not rewrite the message, and it
 * does not catch: the chosen transport still owns the From decision, and the
 * error it throws must reach drainEmailQueue with its type intact, because that
 * type is the queue's whole transient/permanent split.
 *
 * The throughput consequence is real and worth stating where the routing
 * happens: Graph sends as a Yale shared mailbox and inherits Exchange Online's
 * ~30 messages/minute submission cap, which is the reason MailerooTransport
 * exists at all. A roster-wide campaign sent from a yale.edu identity paces out
 * over hours; the same campaign from a havenfreeclinic.org identity does not.
 */
export class SigningDomainRouter implements EmailTransport {
  private readonly fallback: EmailTransport;
  private readonly signers: Partial<Record<SigningTransport, EmailTransport>>;

  constructor(opts: {
    /** Used for a From on no listed domain, and for a message with no From. */
    fallback: EmailTransport;
    /** The transport to use for each signing capability that is available here. */
    signers: Partial<Record<SigningTransport, EmailTransport>>;
  }) {
    this.fallback = opts.fallback;
    this.signers = opts.signers;
  }

  async send(message: EmailMessage): Promise<void> {
    const signer = signingTransportFor(message.from);
    // A capability with no transport wired for it falls back rather than
    // failing: the allowlist describes what the DOMAINS support, and a given
    // deployment may not have every transport configured.
    const chosen = (signer && this.signers[signer]) ?? this.fallback;
    await chosen.send(message);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Resolve the email transport from admin settings (DB override -> env default).
 */
export async function resolveEmailTransport(): Promise<EmailTransport> {
  // Read UNcached. This runs once per drain (a cron path, not per render), and a
  // 30s-stale "log" during a transport switch would drain real mail through
  // LogTransport and mark it SENT with no retry path (#76). The fresh value
  // routes correctly, or fails loudly below when graph has no sender.
  const transport = await getSettingUncached<"log" | "graph" | "maileroo">("email.transport");
  if (transport === "maileroo") {
    const sender = await getSettingUncached<string>("email.sender");
    const apiKey = config.MAILEROO_API_KEY;
    // Same rule as the graph branch below: in production a missing credential
    // must NOT silently degrade to LogTransport, which resolves fine and lets the
    // drain mark every row SENT while delivering nothing.
    if (!apiKey || !sender) {
      const missing = [!apiKey && "MAILEROO_API_KEY", !sender && "email.sender"].filter(Boolean);
      if (isProductionRuntime()) {
        return new UnconfiguredTransport(
          `email.transport is 'maileroo' but ${missing.join(" and ")} is not configured -- refusing to route mail to the log transport in production (would record undelivered mail as SENT)`,
        );
      }
      log.warn(
        "[email] transport is maileroo but it is not fully configured; falling back to log transport",
      );
      return new LogTransport();
    }
    const maileroo = new MailerooTransport({ apiKey, sender });
    // Route by From domain. yale.edu is on the allowlist as GRAPH-signed (its
    // Maileroo entry is registered but disabled), so a message whose From names a
    // Yale identity goes out through Graph AS ITSELF rather than being pinned to
    // `sender` with the address demoted to Reply-To. Everything else, including a
    // message with no From at all, stays on Maileroo.
    //
    // GraphTransport's `sender` is only its default for a message that carries no
    // From, and the router never hands it one: a message reaches the graph signer
    // precisely because its own From named a graph-signed domain. It is passed to
    // honor the constructor's contract, not because this path reads it.
    //
    // Deliberately one-directional: the graph branch below does NOT gain a
    // Maileroo signer for havenfreeclinic.org. email.transport is an explicit
    // operator choice, and making "graph" quietly send part of its mail through
    // Maileroo on the mere presence of MAILEROO_API_KEY would be a routing change
    // nobody asked for. The deployed transport is maileroo, which is the case
    // this routing exists to serve.
    return new SigningDomainRouter({
      fallback: maileroo,
      signers: { maileroo, graph: new GraphTransport({ getAccessToken, sender }) },
    });
  }
  if (transport === "graph") {
    const sender = await getSettingUncached<string>("email.sender");
    // The write guard blocks enabling graph without a sender, but a later reset of
    // email.sender could leave graph active with no sender. In production this must
    // NOT silently fall back to the log transport: LogTransport resolves successfully,
    // so the drain marks every row SENT while delivering nothing (green dashboard,
    // zero delivery, including magic-link logins). Throw so the send fails loudly --
    // rows go FAILED, the admin Failed card lights, and the drain logs it. In dev/CI
    // keep the log fallback so local runs without a sender still work.
    if (!sender) {
      if (isProductionRuntime()) {
        return new UnconfiguredTransport(
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

  // Resolved to "log" in production. The setting read above degrades to
  // config.EMAIL_TRANSPORT rather than throwing when the database is briefly
  // unreachable or the Setting table is missing (getSettingUncached catches
  // P1001/P2021/P2022), so one bad read could collapse a live transport to "log"
  // -- and LogTransport RESOLVES, which means the drain would stamp every row in
  // the batch SENT while delivering nothing. Terminal, no lastError, no retry.
  //
  // Not observed in production (30 days of logs contain no "[email] from=..."
  // line, audit 14 finding 11), so this is a guard against a latent hazard, not a
  // fix for an active one -- but it is the same argument the graph and maileroo
  // branches above already make, and they only cover a MISSING credential.
  if (isProductionRuntime()) {
    return new UnconfiguredTransport(
      "email.transport resolved to 'log' in production -- refusing to record undelivered mail as SENT. Check the email.transport setting, and whether the settings read degraded to its env default.",
    );
  }
  return new LogTransport();
}

/**
 * True on a real deployment. Kept in one place because the three refusals above
 * must agree, and because VERCEL_ENV is set on preview deploys too -- a preview
 * that silently marked mail SENT would be just as misleading as production.
 */
function isProductionRuntime(): boolean {
  return process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
}
