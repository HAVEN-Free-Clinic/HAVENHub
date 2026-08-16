/**
 * Normalisation for the two identifiers HAVEN copies by hand out of Yale New
 * Haven Health's systems: the ServiceNow service request number ("RITM0345759")
 * and the Epic user ID ("CARNEYJU").
 *
 * Both are TYPED, not synced. There is no ServiceNow or Epic integration here,
 * and there is no prospect of one soon, so every value arrives by someone
 * reading it off an email and retyping it. That makes the usual transcription
 * failures the real failure mode: a trailing space from a copy-paste, the
 * label pasted along with the value ("RITM: RITM0345759"), a stray newline,
 * a lowercase spelling that then never matches the uppercase one on the record.
 *
 * These functions exist to catch exactly that class and nothing more. They
 * deliberately do NOT enforce a house format: HAVEN does not issue either
 * identifier and cannot know when YNHH changes its numbering. A validator that
 * is stricter than the issuer is a validator that eventually rejects a real,
 * correct value at the worst moment, with no way around it.
 */

import { SupportStateError } from "./tech-request";

/** Anything that is not a letter, digit, hyphen, underscore or period. */
const DISALLOWED = /[^A-Za-z0-9._-]/;

/**
 * Trims, uppercases, and rejects a value that cannot be an identifier.
 *
 * Uppercasing is safe for both: YNHH issues them uppercase, every surface in
 * this app renders them uppercase, and treating "carneyju" as a different
 * value from "CARNEYJU" only ever produces a duplicate nobody can see is a
 * duplicate.
 */
function normalizeIdentifier(raw: string, label: string, maxLength: number): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new SupportStateError(`${label} cannot be blank.`);
  if (trimmed.length > maxLength) {
    throw new SupportStateError(`${label} looks too long (${trimmed.length} characters). Paste just the identifier.`);
  }
  if (DISALLOWED.test(trimmed)) {
    // Names the offending character rather than restating the rule: the common
    // cause is a pasted label or a stray space, and seeing which character
    // failed makes that obvious without reading a spec.
    const bad = trimmed.match(DISALLOWED)?.[0] ?? "";
    const shown = bad.trim() === "" ? "a space" : `"${bad}"`;
    throw new SupportStateError(`${label} contains ${shown}. Paste just the identifier, with no label or spaces.`);
  }
  return trimmed.toUpperCase();
}

/**
 * A YNHH ServiceNow service request number, e.g. "RITM0345759".
 *
 * The prefix is not checked. HAVEN sees at least RITM (request item) and INC
 * (incident) today, the prefixes are YNHH's to change, and a wrong guess here
 * would block recording a real ticket number with no override.
 */
export function normalizeServiceRequestNumber(raw: string): string {
  return normalizeIdentifier(raw, "Service request number", 64);
}

/**
 * An Epic user ID, e.g. "CARNEYJU".
 *
 * Written onto Person.epicId when an Epic request completes, which is what
 * every later MODIFY, RENEW and DEACTIVATE is raised against, so a typo here
 * propagates into requests YNHH cannot action.
 */
export function normalizeEpicId(raw: string): string {
  return normalizeIdentifier(raw, "Epic ID", 32);
}
