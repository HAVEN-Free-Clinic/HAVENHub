/**
 * Thin client over the walletwallet.dev pass API.
 *
 * The vendor exists ONLY behind this file. Passes are a disposable rendering of
 * data the Hub owns: they are signed with the vendor's certificate, so they
 * cannot be migrated to another signer, and the mitigation is that nothing
 * load-bearing depends on them. If this service disappears, members lose a badge
 * and keep their credential.
 *
 * Every call is best-effort and returns null or false instead of throwing. A
 * vendor outage, a 429 (the free tier is 1,000 passes per month counting
 * creations and updates), or a network failure must degrade the badge and never
 * break /my-info or an offboard.
 *
 * NEVER call these inside a Prisma transaction: a vendor timeout would hold a
 * database connection open across a network round trip and could roll back an
 * offboard. This feature has already had three separate transaction-boundary
 * bugs; do not add a fourth.
 */

import { config } from "@/platform/config";
import { log, errorAttrs } from "@/platform/logging";

const BASE = "https://www.walletwallet.dev";

export type PassField = { key: string; label: string; value: string };

export type PassInput = {
  organizationName: string;
  logoText: string;
  description: string;
  /** 1 to 3650. Computed from the term end date at issuance. */
  expirationDays: number;
  primaryFields: PassField[];
  secondaryFields: PassField[];
  /** QR target, or null for a pass with no barcode. */
  barcodeValue: string | null;
};

export type PassResult = {
  serialNumber: string;
  googleSaveUrl: string;
  applePass: string;
  shareUrl: string;
};

export function isWalletEnabled(): boolean {
  return Boolean(config.WALLETWALLET_API_KEY);
}

function body(input: PassInput): Record<string, unknown> {
  return {
    organizationName: input.organizationName,
    logoText: input.logoText,
    description: input.description,
    expirationDays: input.expirationDays,
    primaryFields: input.primaryFields,
    secondaryFields: input.secondaryFields,
    // Custom color and logo are Pro-only; the free tier gets a preset.
    colorPreset: "blue",
    // Defaults true at the vendor, set explicitly so a default change cannot
    // silently make members' badges shareable.
    sharingProhibited: true,
    ...(input.barcodeValue
      ? { barcodeValue: input.barcodeValue, barcodeFormat: "QR" }
      : {}),
  };
}

async function call(
  path: string,
  method: "POST" | "PUT" | "DELETE",
  payload?: Record<string, unknown>,
): Promise<Response | null> {
  const key = config.WALLETWALLET_API_KEY;
  if (!key) return null;
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    if (!response.ok) {
      log.error("[passport] wallet call failed", { path, method, status: response.status });
      return null;
    }
    return response;
  } catch (error) {
    log.error("[passport] wallet call threw", errorAttrs(error, { path, method }));
    return null;
  }
}

export async function createPass(input: PassInput): Promise<PassResult | null> {
  const response = await call("/api/passes", "POST", body(input));
  if (!response) return null;

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    // A 200 with a body that is not valid JSON (an HTML error/maintenance
    // page, a truncated response, a proxy interstitial) must degrade the
    // same as any other vendor failure, not throw out of this best-effort
    // client.
    log.error(
      "[passport] wallet call returned invalid JSON",
      errorAttrs(error, { path: "/api/passes", method: "POST", status: response.status }),
    );
    return null;
  }

  const result = parsed as Partial<PassResult> | null | undefined;
  if (!result || typeof result.serialNumber !== "string" || result.serialNumber.length === 0) {
    // A pass with no serial number can never be updated or revoked later, so
    // it is as unusable as an outright failure.
    log.error("[passport] wallet call returned no serialNumber", {
      path: "/api/passes",
      method: "POST",
      status: response.status,
    });
    return null;
  }
  return result as PassResult;
}

export async function updatePass(serial: string, input: PassInput): Promise<boolean> {
  return Boolean(await call(`/api/passes/${encodeURIComponent(serial)}`, "PUT", body(input)));
}

/** Idempotent at the vendor: repeat deletes are documented no-ops. */
export async function revokePass(serial: string): Promise<boolean> {
  return Boolean(await call(`/api/passes/${encodeURIComponent(serial)}`, "DELETE"));
}
