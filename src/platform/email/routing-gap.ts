/**
 * THE MIGRATION HAZARD, made visible before someone walks into it.
 *
 * Address- and domain-level routing only runs when email.transport is
 * "maileroo". Under "graph" every message goes to Graph and no routing happens
 * at all, so the whole allowlist sits inert and nothing about it can be wrong.
 * That is production's state today.
 *
 * The moment an admin flips that setting, every configured sender address that
 * is NOT Graph-routed silently changes transport. Not fails -- CHANGES, with no
 * error, no log line and no failed row: mail that Exchange has been sending as
 * an intra-tenant message from a Yale mailbox starts arriving at yale.edu
 * inboxes as external mail through a third-party ESP. With GRAPH_SENDER_ADDRESSES
 * unset, which is how it ships, that is EVERY sender rule at once -- compliance
 * reminders, recruitment mail, shift reminders, incident notifications -- moved
 * by a change nobody made a decision about.
 *
 * The flip may well be the right call. What must not happen is it being made
 * without anyone seeing the list. So this reports the list, and the admin
 * surfaces render it wherever that decision is taken (/admin/settings, next to
 * the transport selector) and wherever these addresses are configured
 * (/admin/email). Neither surface BLOCKS the flip: an operator is allowed to
 * decide that all six should move, and the setting's `validate` hook refuses
 * rather than warns, which is the wrong shape for a consequence that may be
 * exactly what was intended.
 *
 * It reports the same list whichever transport is selected, and the RENDERING
 * decides what to do with it: a pending hazard under "graph", a record of what
 * already moved under "maileroo", and nothing at all under "log", where no mail
 * is delivered by any transport and the card would be noise on every
 * developer's machine. Keeping that judgement in the component rather than here
 * is what lets a test assert the list without asserting the copy.
 */
import { isDbUnreachableError, isSchemaMissingError } from "@/platform/db";
import { log } from "@/platform/logging";
import { getSetting } from "@/platform/settings/service";
import { signingTransportFor } from "./sending-domains";
import { listSenderRules, SENDER_CATEGORIES } from "./sender-rules";
import { connectedGraphMailbox } from "./oauth";

/** One configured From that would not go out through Graph. */
export type RoutingGapEntry = {
  address: string;
  /**
   * The rules that send as it, as an admin would name them ("Compliance",
   * "Template: compliance-reminder"). One address commonly serves several, and a
   * bare address list would understate what is moving.
   */
  usedBy: string[];
};

export type EmailRoutingGap = {
  /** The transport setting as it stands right now. */
  transport: "log" | "graph" | "maileroo";
  /** Configured sender-rule addresses that Graph would NOT carry. */
  entries: RoutingGapEntry[];
  /** How many distinct sender-rule addresses ARE Graph-routed. */
  graphRoutedCount: number;
  /**
   * The global email.sender setting, which is the From for every category with
   * no rule of its own -- including `auth`, so magic-link logins are in here.
   * Carried separately from `entries` because it is not a sender rule and the
   * gap list must stay exactly what it claims to be, but reported because a card
   * that named six moving addresses while login mail quietly moved too would
   * understate the blast radius by the one thing nobody can afford to lose.
   */
  globalSender: { address: string; graphRouted: boolean } | null;
};

/**
 * Which configured sender addresses would change transport, and which would not.
 *
 * DEGRADES rather than throwing. /admin/settings survives a brief database
 * outage today (getCategory catches P1001/P2021/P2022 and renders defaults), and
 * a warning card is not worth turning that into a 500 -- an admin who cannot
 * reach the database is not flipping a transport either. Returns null, and the
 * callers render nothing.
 */
export async function emailRoutingGap(): Promise<EmailRoutingGap | null> {
  try {
    const [transport, rules, globalSenderAddress, mailbox] = await Promise.all([
      getSetting<"log" | "graph" | "maileroo">("email.transport"),
      listSenderRules(),
      getSetting<string>("email.sender"),
      connectedGraphMailbox(),
    ]);

    // Keyed as a plain string, not as TemplateGroup: EmailSenderRule.target is a
    // free string column, so a CATEGORY row can name a group that has since been
    // renamed or dropped from SENDER_CATEGORIES. Typing the key narrower would
    // not make that row go away, it would only stop this lookup compiling; the
    // ?? below is what actually handles it, by falling back to the raw target.
    const categoryLabels = new Map<string, string>(
      SENDER_CATEGORIES.map((c) => [c.group as string, c.label])
    );

    // Grouped by address, because three of the clinic's six rules share one
    // mailbox and listing it three times would read as three problems.
    // Lowercased for the key, since routing is case-blind and "HFC.Admin@..."
    // and "hfc.admin@..." are one address moving, not two.
    const byAddress = new Map<string, RoutingGapEntry>();
    let graphRoutedCount = 0;
    const seen = new Set<string>();

    for (const rule of rules) {
      const address = rule.fromEmail.trim();
      const key = address.toLowerCase();
      const label =
        rule.scope === "CATEGORY"
          ? (categoryLabels.get(rule.target) ?? rule.target)
          : `Template: ${rule.target}`;

      // The SEND path's own decision, including the implicit connected-mailbox
      // rule, rather than a second implementation of the precedence. A check
      // that disagreed with the router would be worse than no check.
      const graphRouted = signingTransportFor(address, mailbox.account) === "graph";

      if (!seen.has(key)) {
        seen.add(key);
        if (graphRouted) graphRoutedCount += 1;
      }
      if (graphRouted) continue;

      const existing = byAddress.get(key);
      if (existing) existing.usedBy.push(label);
      else byAddress.set(key, { address, usedBy: [label] });
    }

    const entries = [...byAddress.values()].sort((a, b) => a.address.localeCompare(b.address));
    for (const entry of entries) entry.usedBy.sort();

    return {
      transport,
      entries,
      graphRoutedCount,
      globalSender: globalSenderAddress
        ? {
            address: globalSenderAddress,
            graphRouted: signingTransportFor(globalSenderAddress, mailbox.account) === "graph",
          }
        : null,
    };
  } catch (err) {
    if (isDbUnreachableError(err) || isSchemaMissingError(err)) {
      log.warn("[email] could not resolve the transport routing gap; hiding the card");
      return null;
    }
    throw err;
  }
}
