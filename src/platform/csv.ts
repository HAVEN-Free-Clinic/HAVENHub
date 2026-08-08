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
 */
export function toCsv(headers: string[], rows: string[][]): string {
  return [headers, ...rows]
    .map((row) => row.map(escapeField).join(","))
    .join("\r\n");
}

function escapeField(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
