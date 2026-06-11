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
    expect(parseManifest(MANIFEST)).toEqual({ entryHref: "index.html", version: "1.2" });
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
});
