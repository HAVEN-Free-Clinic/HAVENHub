/** Stable answer-key helpers for the form builder. Keys are immutable once
 *  submissions exist, so generation only happens when a field is first added. */

export function slugifyKey(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base.length > 0 ? base : "field";
}

export function uniqueKey(label: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = slugifyKey(label);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}
