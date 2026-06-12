import { zipSync, strToU8 } from "fflate";

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
      <file href="assets/app.js"/>
    </resource>
  </resources>
</manifest>`;

/** A minimal, valid SCORM 1.2 package: manifest + index.html + one asset. */
export function makeScormZip(): Buffer {
  const files: Record<string, Uint8Array> = {
    "imsmanifest.xml": strToU8(MANIFEST),
    "index.html": strToU8("<!doctype html><title>Lesson</title><script src='assets/app.js'></script>"),
    "assets/app.js": strToU8("console.log('scorm');"),
  };
  return Buffer.from(zipSync(files));
}

const MULTI_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
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

/** A two-SCO SCORM package: manifest + two page files. */
export function makeMultiScoZip(): Buffer {
  const files: Record<string, Uint8Array> = {
    "imsmanifest.xml": strToU8(MULTI_MANIFEST),
    "index.html": strToU8("<!doctype html><title>hb</title>"),
    "html/ytf.html": strToU8("<!doctype html><title>ytf</title>"),
  };
  return Buffer.from(zipSync(files));
}
