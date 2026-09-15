/**
 * One display format for a phone number, wherever the app shows one.
 *
 * Phone numbers are stored exactly as typed (a form, an Airtable import, an
 * application answer), so the same roster printed "(617) 230-4246" on one row
 * and "4087075782" on the next. This formats for DISPLAY only and never rewrites
 * what is stored: an unrecognised shape comes back as typed, so nothing is ever
 * mangled into a wrong number.
 *
 *   - 10 US digits, or 11 with a leading country code 1: "(203) 555-0131"
 *   - either of those plus an extension ("x12", "ext. 12"): "(203) 555-0131 ext. 12"
 *   - anything else (international, too short, letters): trimmed, otherwise as typed
 *
 * Returns null for null, undefined or blank, so callers keep their own
 * "Not set" / "-" empty states.
 */
export function formatPhone(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  // Split off an extension before counting digits, so "203-555-0131 x12" is
  // still recognised as a US number rather than a 12-digit oddity.
  const extMatch = trimmed.match(/^(.*?)\s*(?:x|ext\.?|extension)\s*(\d+)\s*$/i);
  const main = extMatch ? extMatch[1] : trimmed;
  const ext = extMatch ? extMatch[2] : null;

  // Only punctuation a person types into a phone number may sit between the
  // digits. Letters (a vanity number) or a "+" other than "+1" mean this is not
  // a shape we can be sure of, so it is returned untouched.
  if (/[^\d\s().+\-]/.test(main)) return trimmed;
  let digits = main.replace(/\D/g, "");
  if (main.includes("+") && !/^\s*\+1\b/.test(main)) return trimmed;
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return trimmed;

  const formatted = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return ext ? `${formatted} ext. ${ext}` : formatted;
}
