import type { ContractLayout } from "./layout";

export type SignatureMethod = "draw" | "type";

/** What the SignaturePad submits for one signable block. */
export type SignatureInput = { dataUrl: string; method: SignatureMethod; name: string };

/** What we persist per block in OnboardingContract.signatures JSON (new contracts). */
export type StoredSignature = { method: SignatureMethod; name: string; imageKey: string; signedAt: string };

const SIG_PREFIX = "sig__";

export function isStoredSignature(v: unknown): v is StoredSignature {
  return (
    v != null && typeof v === "object" &&
    typeof (v as StoredSignature).imageKey === "string" &&
    typeof (v as StoredSignature).signedAt === "string"
  );
}

/**
 * Group flat form entries into per-block SignatureInput. The pad writes three
 * inputs per block: `sig__<id>` (data URL), `sig__<id>__method`, `sig__<id>__name`.
 * The `__method` / `__name` suffixes are matched first so a block id never
 * collides with a companion (agreement ids never end in those suffixes).
 */
export function collectSignatureInputs(entries: Iterable<[string, string]>): Record<string, SignatureInput> {
  const out: Record<string, SignatureInput> = {};
  const ensure = (id: string): SignatureInput => (out[id] ??= { dataUrl: "", method: "draw", name: "" });
  for (const [key, value] of entries) {
    if (!key.startsWith(SIG_PREFIX)) continue;
    const rest = key.slice(SIG_PREFIX.length);
    if (rest.endsWith("__method")) {
      ensure(rest.slice(0, -"__method".length)).method = value === "type" ? "type" : "draw";
    } else if (rest.endsWith("__name")) {
      ensure(rest.slice(0, -"__name".length)).name = value.trim();
    } else {
      ensure(rest).dataUrl = value;
    }
  }
  return out;
}

export type ContractSignatureRow = {
  blockId: string;
  title: string;
  method: SignatureMethod | null;
  name: string;
  signedAt: string | null;
  imageKey: string | null;   // new drawn signature (server inlines the blob)
  legacyText: string | null; // pre-feature contracts stored a typed name string
};

/**
 * Normalize a contract's stored signatures into display rows, one per agreement
 * block plus an Initials row when that system field is enabled. Handles both the
 * new object shape (StoredSignature) and the legacy typed-name string shape.
 */
export function buildContractSignatureView(layout: ContractLayout, signatures: unknown): ContractSignatureRow[] {
  const map = (signatures ?? {}) as Record<string, unknown>;
  const rows: ContractSignatureRow[] = [];

  const rowFor = (blockId: string, title: string): ContractSignatureRow => {
    const raw = map[blockId];
    if (isStoredSignature(raw)) {
      return { blockId, title, method: raw.method, name: raw.name, signedAt: raw.signedAt, imageKey: raw.imageKey, legacyText: null };
    }
    if (typeof raw === "string" && raw.trim()) {
      return { blockId, title, method: null, name: raw, signedAt: null, imageKey: null, legacyText: raw };
    }
    return { blockId, title, method: null, name: "", signedAt: null, imageKey: null, legacyText: null };
  };

  for (const b of layout.blocks) {
    if (b.kind === "agreement") rows.push(rowFor(b.id, b.title));
  }
  const initialsEnabled = layout.blocks.some(
    (b) => b.kind === "system_field" && b.systemKey === "initials" && b.enabled !== false,
  );
  if (initialsEnabled) rows.push(rowFor("initials", "Initials"));
  return rows;
}
