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

  it("drops non-ASCII chars (e.g. U+202F) from the ASCII filename but keeps them percent-encoded in filename*", () => {
    // OS/browser-generated PDF names embed a narrow no-break space (U+202F)
    // before AM/PM, e.g. "... 2:00 PM.pdf".
    const header = certificateContentDisposition("cert 2.pdf", false);
    expect(header).toBe(
      "attachment; filename=\"cert2.pdf\"; filename*=UTF-8''cert%E2%80%AF2.pdf",
    );
  });

  it("produces a header value that is a valid HTTP header field (no non-Latin1 code points)", () => {
    // Regression: a raw non-Latin1 char in the header value threw a ByteString
    // TypeError ("value ... greater than 255") when constructing the Response,
    // 500-ing the certificate download/preview route.
    const header = certificateContentDisposition("HIPAA Cert 2:00 PM.pdf", true);
    expect(() => new Headers({ "Content-Disposition": header })).not.toThrow();
  });
});
