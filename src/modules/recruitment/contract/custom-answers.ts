import { parseContractLayout } from "./layout";

/**
 * Resolve a contract's stored custom answers into displayable label/value pairs.
 *
 * Keys are matched against the custom_question blocks in the contract's frozen
 * templateSnapshot, which is what makes this safe to render: customAnswers also
 * holds internal confirm__<agreementId> checkbox-agreement keys (submitContract
 * stores them there), and can carry a stale answer to a question this contract
 * never showed. Keying off the snapshot drops both.
 */
export function resolveCustomAnswers(
  templateSnapshot: unknown,
  customAnswers: unknown,
): { label: string; value: string }[] {
  if (templateSnapshot == null) return [];
  const labels: Record<string, string> = {};
  try {
    for (const block of parseContractLayout(templateSnapshot).blocks) {
      if (block.kind === "custom_question") labels[block.key] = block.label;
    }
  } catch {
    // Invalid snapshot: show no custom answers rather than raw keys.
    return [];
  }

  const answers = (customAnswers ?? {}) as Record<string, unknown>;
  const out: { label: string; value: string }[] = [];
  for (const [key, raw] of Object.entries(answers)) {
    if (!(key in labels)) continue;
    if (raw == null || raw === "") continue;
    const value = Array.isArray(raw) ? raw.join(", ") : String(raw);
    if (value === "") continue;
    out.push({ label: labels[key], value });
  }
  return out;
}
