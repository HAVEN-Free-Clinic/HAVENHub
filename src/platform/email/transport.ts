import { getAccessToken } from "./oauth";
import { inlineEmailHtml } from "./render/inline";
import { domainOf, signingTransportFor, type SigningTransport } from "./sending-domains";
import { config } from "@/platform/config";
import { prisma } from "@/platform/db";
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

/**
 * Restate a Graph Send-As refusal as something an operator can act on, or return
 * null for any other failure.
 *
 * This is the accepted cost of routing every yale.edu identity through Graph: an
 * address the connected mailbox holds no Send-As grant on is refused, and the
 * decision to accept that was made knowing so. Legibility was the mitigation.
 * Raw, Graph says only:
 *
 *   Graph sendMail failed: 403 {"error":{"code":"ErrorAccessDenied","message":
 *   "Access is denied. Check credentials and try again."}}
 *
 * which names neither the address it tried to send as, nor Send-As, nor any
 * remedy -- and "check credentials" actively points at the wrong thing, because
 * the credentials are fine and the grant is what is missing.
 *
 * ACTION FIRST, for the same reason as describeMailerooDomainRejection: the admin
 * Failed card truncates EmailLog.lastError to 60 characters, and log.error does
 * not fire until all 8 attempts are spent. The Graph error code is kept, demoted
 * behind the remedy.
 *
 * Narrow on purpose. Only a 403 whose body names an access/Send-As denial is
 * restated; every other 403 (a quota, a blocked mailbox) keeps the raw text
 * rather than being given a confident wrong diagnosis.
 */
function describeGraphSendAsRejection(
  status: number,
  sender: string,
  text: string
): string | null {
  if (status !== 403) return null;
  if (!/ErrorAccessDenied|ErrorSendAsDenied|Access is denied/i.test(text)) return null;
  return (
    `Grant Send-As on ${sender} to the connected mailbox, or send as the mailbox itself. ` +
    `Graph refused the send: the delegated token is valid, the Send-As right on that address ` +
    `is what is missing. Permanent: retrying cannot grant a mailbox permission. ` +
    `Graph said: 403 ${text}`
  );
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
      // A Send-As refusal is the one 4xx with a specific, actionable cause, and
      // it is the failure mode routing every yale.edu identity here creates.
      const sendAs = describeGraphSendAsRejection(res.status, sender, text);
      throw new Error(sendAs ?? `Graph sendMail failed: ${res.status} ${text}`);
    }
  }
}

// ---------------------------------------------------------------------------
// MailerooTransport
// ---------------------------------------------------------------------------

/** POST target for a single transactional send (Maileroo API v2). */
const MAILEROO_SEND_URL = "https://smtp.maileroo.com/api/v2/emails";

/**
 * A domain in a Maileroo error, however that release happens to quote it: single,
 * double, backtick, or bare. The wording is not a contract, so neither is the
 * punctuation. Resolves to:
 *
 *   (?:\\?['"`])?([^'"`\\\s]+)(?:\\?['"`])?
 *
 * The optional BACKSLASH before each quote is what makes this work on the
 * !res.ok path. Maileroo answers JSON, and that branch runs the recogniser on
 * res.text(), which is still JSON-escaped: a double-quoted domain arrives as
 * \\"yale.edu\\", not "yale.edu". Without it that payload matched on the
 * 200/success:false branch (which reads the already-parsed body.message) and
 * missed on the non-2xx branch, which is exactly the "the diagnosis depends on
 * which shape the API used" failure this recogniser exists to prevent -- and at
 * 503 the miss is a transient verdict burning the queue's back-off.
 *
 * Excluding the backslash from the domain class is the other half. With the
 * optional escape but a permissive class the pattern DOES match, and captures
 * "yale.edu\\" with the escape still attached, which then lands in the message an
 * operator reads and may paste back into SENDING_DOMAINS.
 */
const REJECTED_DOMAIN = "(?:\\\\?['\"`])?([^'\"`\\\\\\s]+)(?:\\\\?['\"`])?";

/** "The domain 'x' is currently disabled", and the phrasings next to it. */
const MAILEROO_DISABLED_RE = new RegExp(
  `domain\\s+${REJECTED_DOMAIN}\\s+(?:is|has been)\\s+(?:currently\\s+|now\\s+)?disabled`,
  "i"
);

/** "The domain 'x' is not associated with this sending key", and its neighbours. */
const MAILEROO_WRONG_KEY_RE = new RegExp(
  `domain\\s+${REJECTED_DOMAIN}\\s+is\\s+not\\s+(?:associated|linked)\\s+(?:with|to)\\s+this\\s+sending\\s+key`,
  "i"
);

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
 * That second claim is why the two regexes above are tolerant of phrasing. An
 * exact-phrase match would have survived only the pairing "Maileroo changed the
 * status code but kept the sentence byte-identical", which is the least likely
 * one. They are still recognisers, not a parser: an unrecognised text falls
 * through to the generic rules, which keep a 4xx permanent and would classify a
 * 5xx transient.
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
 *
 * ACTION FIRST, deliberately. The admin Failed card truncates EmailLog.lastError
 * to 60 characters (admin/email/page.tsx) and log.error does not fire until all
 * 8 attempts are spent, so those 60 characters are the whole diagnosis for a long
 * time. A leading "Maileroo send failed: 400 " status line spent 26 of them
 * saying nothing an operator can act on; the status now trails instead.
 */
function describeMailerooDomainRejection(text: string): string | null {
  const disabled = MAILEROO_DISABLED_RE.exec(text);
  if (disabled) {
    return (
      `Re-enable '${disabled[1]}' in the Maileroo dashboard, or point it at another transport ` +
      `in SENDING_DOMAINS. Maileroo has that sending domain but it is disabled there, so nothing ` +
      `from it can be signed. Permanent: retrying cannot change a dashboard setting.`
    );
  }
  const wrongKey = MAILEROO_WRONG_KEY_RE.exec(text);
  if (wrongKey) {
    return (
      `Use a MAILEROO_API_KEY scoped to '${wrongKey[1]}', or point it at another transport in ` +
      `SENDING_DOMAINS. Maileroo sending keys are domain-scoped and this one belongs to a ` +
      `different domain. Permanent: retrying cannot re-scope a key.`
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
        throw new Error(`${domainRejection} (Maileroo answered ${res.status})`);
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
      const domainRejection = describeMailerooDomainRejection(message);
      throw new Error(
        domainRejection
          ? `${domainRejection} (Maileroo rejected the send)`
          : `Maileroo send rejected: ${message}`
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
 * The router routes and nothing else. It does not rewrite the message, and the
 * error the chosen transport throws must reach drainEmailQueue with its type
 * intact, because that type is the queue's whole transient/permanent split.
 *
 * It does add one fact to a PERMANENT failure, because it is the only layer that
 * holds it: WHY this message was on that transport. Without it, a Graph failure
 * inside a Maileroo deployment reads as a broken Graph mailbox rather than as a
 * consequence of the From domain's allowlist row, which sends an operator to fix
 * the wrong thing. The note is appended, never prepended, so the transport's own
 * remedy still occupies the 60 characters the admin Failed card shows.
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
    // Nothing was rerouted when the fallback handled it, including the common
    // case where the maileroo signer IS the fallback, so there is nothing to
    // explain and the error passes through untouched.
    if (!signer || chosen === this.fallback) {
      await chosen.send(message);
      return;
    }
    try {
      await chosen.send(message);
    } catch (err) {
      throw annotateRoutedFailure(err, message.from, signer);
    }
  }
}

/**
 * Append the routing decision to a permanent failure from a rerouted message.
 *
 * The message is MUTATED on the caught error rather than re-wrapped in a fresh
 * one, deliberately: drainEmailQueue splits transient from permanent on
 * `instanceof TransientEmailError`, and isTransientSendCause additionally reads
 * `err.name` (MailNotConnectedError, TimeoutError, AbortError, TypeError). A new
 * Error would silently re-classify the failure, which is a far worse bug than an
 * unhelpful message.
 *
 * Transient failures are left alone. They are going to be retried, so routing
 * advice on them is noise on a row that is not stuck.
 */
function annotateRoutedFailure(
  err: unknown,
  from: string | undefined,
  signer: SigningTransport
): unknown {
  if (!(err instanceof Error) || err instanceof TransientEmailError) return err;
  const domain = domainOf(from) ?? "its domain";
  err.message =
    `${err.message} [Routing: SENDING_DOMAINS lists ${domain} as ${signer}-signed, which is why ` +
    `${from} was sent through ${signer} rather than the default transport. Take ${domain} off ` +
    `SENDING_DOMAINS to send it through the default transport instead.]`;
  return err;
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
      signers: { maileroo, graph: await resolveGraphSigner(sender) },
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
 * Build the Graph signer for a Maileroo-primary deployment, refusing PER MESSAGE
 * with a named reason when Graph cannot possibly sign.
 *
 * This exists because the maileroo branch above goes to real trouble to refuse a
 * missing MAILEROO_API_KEY or email.sender, and then used to wire its Graph
 * signer with no precondition check at all. The two failures that produced are
 * both misdiagnoses, not merely terse ones:
 *
 *   - No connected mailbox. Entirely plausible on a deployment that chose
 *     Maileroo precisely to avoid Graph. Every yale.edu-From row then failed with
 *     "Mail account is not connected. An admin must connect the mailbox in Admin
 *     > Email", which reads as a broken Graph connection rather than as a
 *     consequence of the From domain's allowlist row. The blast radius includes
 *     the `auth` sender category (SENDER_CATEGORIES in sender-rules.ts), so a
 *     yale.edu auth sender rule on a Graph-unconnected deployment means people
 *     cannot log in, diagnosed as a mailbox problem.
 *   - Missing GRAPH_OAUTH_* credentials, which surfaced as an opaque Entra 400.
 *
 * The refusal is a per-message UnconfiguredTransport rather than a throw, for
 * exactly the reason that class exists: a throw at resolution time escapes before
 * a single row is claimed and takes the whole cron tick with it (audit 14,
 * EMAIL-1). And it refuses ONLY the Graph-routed messages: a deployment with no
 * Graph mailbox still sends all of its havenfreeclinic.org mail.
 *
 * Both messages lead with the SENDING_DOMAINS lever, because that is the fix an
 * operator can apply immediately and it must survive the admin Failed card's
 * 60-character truncation.
 */
async function resolveGraphSigner(sender: string): Promise<EmailTransport> {
  const missing = [
    !config.GRAPH_OAUTH_TENANT_ID && "GRAPH_OAUTH_TENANT_ID",
    !config.GRAPH_OAUTH_CLIENT_ID && "GRAPH_OAUTH_CLIENT_ID",
    !config.GRAPH_OAUTH_CLIENT_SECRET && "GRAPH_OAUTH_CLIENT_SECRET",
  ].filter((name): name is string => Boolean(name));
  if (missing.length > 0) {
    return new UnconfiguredTransport(
      `Take this domain off SENDING_DOMAINS, or set ${missing.join(" and ")}. ` +
        `SENDING_DOMAINS routes this From to Graph, but Graph has no OAuth credentials ` +
        `configured, so it can never sign for it.`
    );
  }
  if (!(await graphMailboxConnected())) {
    return new UnconfiguredTransport(
      "Take this domain off SENDING_DOMAINS, or connect a mailbox in Admin > Email. " +
        "SENDING_DOMAINS routes this From to Graph, and no Graph mailbox is connected on this " +
        "deployment. This is a routing consequence, not a broken mailbox: nothing else needs " +
        "Graph here, and mail on every other domain is unaffected."
    );
  }
  return new GraphTransport({ getAccessToken, sender });
}

/** Whether an admin has connected a Graph mailbox (the singleton MailCredential). */
async function graphMailboxConnected(): Promise<boolean> {
  try {
    const row = await prisma.mailCredential.findUnique({
      where: { id: "mailer" },
      select: { id: true },
    });
    return row !== null;
  } catch {
    // A brief database problem must NOT be read as "not connected": that would
    // refuse every Graph-routed send for the whole tick on the strength of one
    // failed read. Assume connected and let GraphTransport produce the real
    // per-message error, which is the same direction the settings reads above
    // degrade in.
    return true;
  }
}

/**
 * True on a real deployment. Kept in one place because the three refusals above
 * must agree, and because VERCEL_ENV is set on preview deploys too -- a preview
 * that silently marked mail SENT would be just as misleading as production.
 */
function isProductionRuntime(): boolean {
  return process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
}
