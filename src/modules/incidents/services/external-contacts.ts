/**
 * Clinical supervisors outside the Hub who a reviewer may forward an incident
 * report or an issued strike to.
 *
 * This used to be a blind-copy list: `incidents.externalEscalationEmails` held
 * comma-separated addresses and EVERY address received EVERY non-anonymous
 * report and strike. It is now a directory a reviewer picks from case by case,
 * which means a contact needs a name a human can recognize in a picker.
 *
 * The format therefore accepts `Dr. Jane Smith <jsmith@yale.edu>` while still
 * parsing the bare, comma-separated addresses already stored in production. That
 * back-compatibility is the point: without it, deploying this change would empty
 * the picker for every existing recipient until someone retyped the setting.
 */

import { getSetting } from "@/platform/settings/service";

export type ExternalContact = {
  /** Display name, or null when the entry is a bare address. */
  name: string | null;
  /** Lowercased address. */
  email: string;
};

/** `Name <email>` or a bare address. Captures the name only when angle brackets are present. */
const CONTACT = /^(?:(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>|([^<>\s]+@[^<>\s]+))$/;

/**
 * Parses the raw setting into a de-duplicated contact list.
 *
 * Entries are separated by newlines OR commas, so a legacy single-line value and
 * a new one-per-line value both work. Anything that does not resolve to an
 * address is dropped rather than surfaced as an error: this is a free-text
 * settings field, and a stray line must not take the whole picker down.
 */
export function parseExternalContacts(raw: string | null | undefined): ExternalContact[] {
  if (!raw) return [];

  const out: ExternalContact[] = [];
  const seen = new Set<string>();

  for (const entry of raw.split(/[\n,]+/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const match = CONTACT.exec(trimmed);
    if (!match) continue;

    const email = (match[2] ?? match[3] ?? "").trim().toLowerCase();
    if (!email) continue;
    // First entry for an address wins, so a named line ahead of a bare
    // duplicate keeps the name rather than being flattened to null.
    if (seen.has(email)) continue;
    seen.add(email);

    const name = (match[1] ?? "").trim();
    out.push({ name: name || null, email });
  }

  return out;
}

/** The configured directory. Empty when the setting is unset. */
export async function externalContacts(): Promise<ExternalContact[]> {
  return parseExternalContacts(await getSetting<string>("incidents.externalEscalationEmails"));
}
