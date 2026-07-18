import { contentDisposition } from "@/platform/content-disposition";

/**
 * Build a Content-Disposition header value for a certificate file.
 *
 * Thin wrapper over the shared {@link contentDisposition} helper (the single
 * hardened path all download routes share) that pins the certificate-specific
 * fallback name. See that helper for why non-ASCII (e.g. U+202F) must be
 * stripped from the plain `filename` parameter.
 */
export function certificateContentDisposition(fileName: string, inline: boolean): string {
  return contentDisposition(fileName, { inline, fallbackName: "certificate.pdf" });
}
