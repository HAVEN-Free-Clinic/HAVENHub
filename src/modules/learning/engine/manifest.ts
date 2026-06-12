import { XMLParser } from "fast-xml-parser";

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/** One launchable SCO from the manifest organization (a "page"). */
export type ScoEntry = {
  /** Stable identifier: the <item> identifier (falls back to href). */
  id: string;
  /** Display title for the table of contents. */
  title: string;
  /** Launch file relative to the package root (e.g. "html/ytf.html"). */
  href: string;
};

export type ParsedManifest = {
  /** First SCO's launch file -- kept for back-compat (e.g. "index.html"). */
  entryHref: string;
  /** SCORM schema version, e.g. "1.2". */
  version: string;
  /** Every SCO, in organization order. Always at least one entry. */
  scos: ScoEntry[];
};

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Pull plain text out of an <item><title> value (string, number, or {#text}). */
function textOf(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && "#text" in (v as Record<string, unknown>)) {
    const t = (v as Record<string, unknown>)["#text"];
    return typeof t === "string" ? t.trim() || null : null;
  }
  return null;
}

/** Depth-first walk of the item tree, collecting every item that resolves to a resource href. */
function collectScos(
  item: Record<string, unknown>,
  resources: Record<string, unknown>[],
  out: ScoEntry[]
): void {
  const ref = item["@_identifierref"];
  if (typeof ref === "string" && ref) {
    const res = resources.find((r) => r["@_identifier"] === ref);
    const href = res?.["@_href"];
    if (typeof href === "string" && href) {
      const id = item["@_identifier"];
      out.push({
        id: typeof id === "string" && id ? id : href,
        title: textOf(item["title"]) ?? href,
        href,
      });
    }
  }
  for (const child of toArray(item["item"] as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
    collectScos(child, resources, out);
  }
}

/**
 * Parse an imsmanifest.xml string into the ordered SCO list + version.
 *
 * Resolution: pick the default organization (or the first), walk its items
 * depth-first, and emit one SCO per item that resolves to a <resource href>. If no
 * item references a resource, fall back to the first resource that has an href.
 * Throws ManifestError when the XML is unparseable or no launchable resource exists.
 */
export function parseManifest(xml: string): ParsedManifest {
  let doc: Record<string, unknown>;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      removeNSPrefix: true,
    });
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new ManifestError("Could not parse imsmanifest.xml.");
  }

  const manifest = doc["manifest"] as Record<string, unknown> | undefined;
  if (!manifest) throw new ManifestError("imsmanifest.xml has no <manifest> root.");

  const resources = toArray(
    (manifest["resources"] as Record<string, unknown> | undefined)?.["resource"] as
      | Record<string, unknown>
      | Record<string, unknown>[]
      | undefined
  );

  const orgs = manifest["organizations"] as Record<string, unknown> | undefined;
  const orgList = toArray(orgs?.["organization"] as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const defaultId = orgs?.["@_default"];
  const org = orgList.find((o) => o["@_identifier"] === defaultId) ?? orgList[0];

  const scos: ScoEntry[] = [];
  if (org) {
    for (const item of toArray(org["item"] as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
      collectScos(item, resources, scos);
    }
  }

  if (scos.length > 0) {
    return { entryHref: scos[0].href, version: schemaVersion(manifest), scos };
  }

  // Fallback: first resource with an href (prefer a SCO) -> a single synthetic SCO.
  const sco = resources.find((r) => r["@_scormtype"] === "sco" && typeof r["@_href"] === "string");
  const any = sco ?? resources.find((r) => typeof r["@_href"] === "string");
  const href = any?.["@_href"];
  if (typeof href === "string" && href) {
    return {
      entryHref: href,
      version: schemaVersion(manifest),
      scos: [{ id: href, title: href, href }],
    };
  }

  throw new ManifestError("imsmanifest.xml has no launchable resource (no <resource href>).");
}

function schemaVersion(manifest: Record<string, unknown>): string {
  const md = manifest["metadata"] as Record<string, unknown> | undefined;
  const v = md?.["schemaversion"];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return "1.2";
}
