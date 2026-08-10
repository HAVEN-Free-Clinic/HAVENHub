/**
 * Minimal RFC 4180 CSV writer.
 *
 * Pure formatting only, with no domain knowledge: callers build their own rows
 * and pass strings. Fields are quoted only when they have to be (they contain a
 * comma, a double quote, CR, or LF), and an internal double quote is doubled.
 * Rows are joined with CRLF, which is what RFC 4180 specifies and what Excel
 * expects.
 *
 * A blank value stays an empty field rather than being dropped, so every row
 * keeps the same column count as the header.
 *
 * `neutralizeFormulas` is opt-in and off by default, so this stays a pure
 * RFC 4180 writer for callers that do not need it. A caller writing
 * user-supplied text for Excel (a name, an email) should turn it on: a field
 * starting with =, +, -, @, a tab, or a CR opens as a live formula in Excel
 * and Google Sheets (CSV formula injection), and a prefixed "'" defuses it
 * the same way Excel's own "Text" import option would.
 */
export function toCsv(
  headers: string[],
  rows: string[][],
  opts: { neutralizeFormulas?: boolean } = {}
): string {
  return [headers, ...rows]
    .map((row) => row.map((value) => escapeField(value, opts.neutralizeFormulas)).join(","))
    .join("\r\n");
}

const DANGEROUS_LEADING_CHAR = /^[=+\-@\t\r]/;

function escapeField(value: string, neutralizeFormulas = false): string {
  const safe = neutralizeFormulas && DANGEROUS_LEADING_CHAR.test(value) ? `'${value}` : value;
  if (!/[",\r\n]/.test(safe)) return safe;
  return `"${safe.replace(/"/g, '""')}"`;
}
