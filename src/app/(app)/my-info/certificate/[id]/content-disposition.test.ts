import { describe, expect, it } from "vitest";
import { certificateContentDisposition } from "./content-disposition";

describe("certificateContentDisposition", () => {
  it("builds an attachment header by default", () => {
    expect(certificateContentDisposition("cert.pdf", false)).toBe(
      "attachment; filename=\"cert.pdf\"; filename*=UTF-8''cert.pdf",
    );
  });

  it("builds an inline header when inline is true", () => {
    expect(certificateContentDisposition("cert.pdf", true)).toBe(
      "inline; filename=\"cert.pdf\"; filename*=UTF-8''cert.pdf",
    );
  });

  it("strips control chars and quotes from the ASCII filename but keeps the encoded original", () => {
    const header = certificateContentDisposition("a\"b\x01.pdf", false);
    expect(header).toBe(
      "attachment; filename=\"ab.pdf\"; filename*=UTF-8''a%22b%01.pdf",
    );
  });

  it("falls back to certificate.pdf when the name sanitizes to empty", () => {
    const header = certificateContentDisposition('"""', true);
    expect(header).toBe(
      "inline; filename=\"certificate.pdf\"; filename*=UTF-8''%22%22%22",
    );
  });
});
