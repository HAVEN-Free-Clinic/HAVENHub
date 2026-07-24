import { describe, expect, it } from "vitest";
import { validateUploadedFile, type UploadedFile } from "./upload";
import type { FieldValidation } from "../engine/schema-builder";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function file(mimeType: string, fileName = "f", bytes = Buffer.from("x")): UploadedFile {
  return { fileName, mimeType, bytes };
}
const rules = (v: Partial<FieldValidation>): FieldValidation => v as FieldValidation;

describe("validateUploadedFile", () => {
  // #23: the builder's single "Word" choice stores only application/msword, so a
  // .docx (OOXML) was rejected outright, blocking a required-resume submission.
  it("accepts a .docx (OOXML) when the field accepts application/msword (#23)", () => {
    expect(
      validateUploadedFile(file(DOCX, "resume.docx"), rules({ acceptedTypes: ["application/msword"] }), 5),
    ).toBeNull();
  });

  it("accepts a legacy .doc when the field accepts the OOXML docx type (#23)", () => {
    expect(
      validateUploadedFile(file("application/msword", "resume.doc"), rules({ acceptedTypes: [DOCX] }), 5),
    ).toBeNull();
  });

  it("still rejects a type outside the accepted family", () => {
    expect(
      validateUploadedFile(file("image/png", "x.png"), rules({ acceptedTypes: ["application/msword"] }), 5),
    ).not.toBeNull();
  });

  it("accepts an exact MIME match and honors a wildcard", () => {
    expect(validateUploadedFile(file("application/pdf", "r.pdf"), rules({ acceptedTypes: ["application/pdf"] }), 5)).toBeNull();
    expect(validateUploadedFile(file("image/jpeg", "p.jpg"), rules({ acceptedTypes: ["image/*"] }), 5)).toBeNull();
  });

  it("still enforces the size cap", () => {
    const big: UploadedFile = { fileName: "r.pdf", mimeType: "application/pdf", bytes: Buffer.alloc(6 * 1024 * 1024) };
    expect(validateUploadedFile(big, rules({ acceptedTypes: ["application/pdf"], maxFileMB: 5 }), 5)).not.toBeNull();
  });
});
