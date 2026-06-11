import { XMLParser } from "fast-xml-parser";

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export type ParsedManifest = {
  /** Launch file, relative to the package root (e.g. "index.html"). */
  entryHref: string;
  /** SCORM schema version, e.g. "1.2". */
  version: string;
};

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Depth-first search for the first item carrying an identifierref. */
function firstItemRef(item: Record<string, unknown>): string | null {
  const ref = item["@_identifierref"];
  if (typeof ref === "string" && ref) return ref;
  for (const child of toArray(item["item"] as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
    const found = firstItemRef(child as Record<string, unknown>);
    if (found) return found;
  }
  return null;
}

/**
 * Parse an imsmanifest.xml string into the launch href + version.
 *
 * Resolution: pick the default organization (or the first), find the first item
 * with an identifierref, resolve it to a <resource href>. If no item references a
 * resource, fall back to the first resource that has an href. Throws ManifestError
 * when the XML is unparseable or no launchable resource exists.
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

  // Try to resolve via the default organization's first referenced resource.
  const orgs = manifest["organizations"] as Record<string, unknown> | undefined;
  const orgList = toArray(orgs?.["organization"] as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const defaultId = orgs?.["@_default"];
  const org =
    orgList.find((o) => o["@_identifier"] === defaultId) ?? orgList[0];

  if (org) {
    for (const item of toArray(org["item"] as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
      const ref = firstItemRef(item);
      if (ref) {
        const res = resources.find((r) => r["@_identifier"] === ref);
        const href = res?.["@_href"];
        if (typeof href === "string" && href) {
          return { entryHref: href, version: schemaVersion(manifest) };
        }
      }
    }
  }

  // Fallback: first resource with an href (prefer a SCO).
  const sco = resources.find((r) => r["@_scormtype"] === "sco" && typeof r["@_href"] === "string");
  const any = sco ?? resources.find((r) => typeof r["@_href"] === "string");
  const href = any?.["@_href"];
  if (typeof href === "string" && href) {
    return { entryHref: href, version: schemaVersion(manifest) };
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
