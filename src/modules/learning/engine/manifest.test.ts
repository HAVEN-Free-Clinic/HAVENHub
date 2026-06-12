import { describe, expect, it } from "vitest";
import { parseManifest, ManifestError } from "./manifest";

const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MAN-1" version="1.2"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>Course</title>
      <item identifier="ITEM-1" identifierref="RES-1"><title>Lesson</title></item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-1" type="webcontent" adlcp:scormtype="sco" href="index.html">
      <file href="index.html"/>
    </resource>
  </resources>
</manifest>`;

describe("parseManifest", () => {
  it("returns the launch href and version from the default organization", () => {
    const parsed = parseManifest(MANIFEST);
    expect(parsed.entryHref).toBe("index.html");
    expect(parsed.version).toBe("1.2");
  });

  it("falls back to the first resource with an href when items lack identifierref", () => {
    const xml = MANIFEST.replace('identifierref="RES-1"', "");
    expect(parseManifest(xml).entryHref).toBe("index.html");
  });

  it("throws ManifestError when there is no launchable resource", () => {
    const xml = MANIFEST.replace(/<resources>[\s\S]*<\/resources>/, "<resources></resources>");
    expect(() => parseManifest(xml)).toThrow(ManifestError);
  });

  it("throws ManifestError on unparseable input", () => {
    expect(() => parseManifest("not xml at all")).toThrow(ManifestError);
  });

  const MULTI = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MAN-2"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>Course</title>
      <item identifier="ITEM-A" identifierref="RES-A"><title>hb</title></item>
      <item identifier="ITEM-B" identifierref="RES-B"><title>ytf</title></item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-A" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource>
    <resource identifier="RES-B" adlcp:scormtype="sco" href="html/ytf.html"><file href="html/ytf.html"/></resource>
  </resources>
</manifest>`;

  it("returns every SCO in organization order with id, title and href", () => {
    const parsed = parseManifest(MULTI);
    expect(parsed.scos).toEqual([
      { id: "ITEM-A", title: "hb", href: "index.html" },
      { id: "ITEM-B", title: "ytf", href: "html/ytf.html" },
    ]);
    expect(parsed.entryHref).toBe("index.html");
  });

  it("single-item manifest yields a one-entry SCO list", () => {
    expect(parseManifest(MANIFEST).scos).toEqual([
      { id: "ITEM-1", title: "Lesson", href: "index.html" },
    ]);
  });

  it("falls back to a single synthetic SCO when items lack identifierref", () => {
    const xml = MANIFEST.replace('identifierref="RES-1"', "");
    const parsed = parseManifest(xml);
    expect(parsed.scos).toHaveLength(1);
    expect(parsed.scos[0].href).toBe("index.html");
    expect(parsed.entryHref).toBe("index.html");
  });

  it("coerces a numeric SCO title to a string", () => {
    const xml = MANIFEST.replace("<title>Lesson</title>", "<title>1</title>");
    expect(parseManifest(xml).scos[0].title).toBe("1");
  });
});
