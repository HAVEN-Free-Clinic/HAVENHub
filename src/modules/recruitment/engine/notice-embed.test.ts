import { describe, expect, it } from "vitest";
import { noticeEmbed, noticeEmbedUrl, resolveNoticeEmbed } from "./notice-embed";

describe("resolveNoticeEmbed", () => {
  it("rewrites a Google Slides edit link to its embed form", () => {
    const e = resolveNoticeEmbed("https://docs.google.com/presentation/d/1AbC_d-9/edit?usp=sharing#slide=id.p");
    expect(e).toEqual({
      kind: "slides",
      src: "https://docs.google.com/presentation/d/1AbC_d-9/embed?start=false&loop=false",
      openUrl: "https://docs.google.com/presentation/d/1AbC_d-9/view",
    });
  });

  it("handles a published-to-web deck", () => {
    const e = resolveNoticeEmbed("https://docs.google.com/presentation/d/e/2PACX-1vQ/pub?start=false");
    expect(e?.src).toBe("https://docs.google.com/presentation/d/e/2PACX-1vQ/embed?start=false&loop=false");
    expect(e?.kind).toBe("slides");
  });

  it("rewrites Google Docs to preview", () => {
    const e = resolveNoticeEmbed("docs.google.com/document/d/XYZ/edit");
    expect(e).toMatchObject({ kind: "document", src: "https://docs.google.com/document/d/XYZ/preview" });
  });

  it("rewrites a Drive file (a PDF on Drive) to preview, including the old open?id= form", () => {
    expect(resolveNoticeEmbed("https://drive.google.com/file/d/abc123/view?usp=drive_link")?.src)
      .toBe("https://drive.google.com/file/d/abc123/preview");
    expect(resolveNoticeEmbed("https://drive.google.com/open?id=abc123")?.src)
      .toBe("https://drive.google.com/file/d/abc123/preview");
  });

  it("embeds a Canva public view link", () => {
    const e = resolveNoticeEmbed("https://www.canva.com/design/DAF1/tok_2/view?utm_content=x");
    expect(e).toMatchObject({ kind: "slides", src: "https://www.canva.com/design/DAF1/tok_2/view?embed" });
  });

  it("frames a direct PDF on any https host", () => {
    expect(resolveNoticeEmbed("https://example.org/files/Role%20Guide.PDF")).toMatchObject({ kind: "document" });
  });

  it("rejects non-https, credentials, unknown pages and script URLs", () => {
    for (const bad of [
      "http://example.org/a.pdf",
      "javascript:alert(1)//.pdf",
      "data:application/pdf;base64,AAAA",
      "https://user:pw@example.org/a.pdf",
      "https://example.org/some-page",
      "https://docs.google.com/spreadsheets/d/abc/edit",
      "https://www.canva.com/design/DAF1/edit",
      "",
      "   ",
    ]) {
      expect(resolveNoticeEmbed(bad), bad).toBeNull();
    }
  });
});

describe("noticeEmbed / noticeEmbedUrl", () => {
  it("reads the link out of the validation blob, tolerating junk", () => {
    expect(noticeEmbedUrl(null)).toBe("");
    expect(noticeEmbedUrl([])).toBe("");
    expect(noticeEmbedUrl({ embedUrl: 4 })).toBe("");
    expect(noticeEmbedUrl({ embedUrl: "  https://x.org/a.pdf " })).toBe("https://x.org/a.pdf");
    expect(noticeEmbed({ embedUrl: "https://example.org/nope" })).toBeNull();
    expect(noticeEmbed({ acknowledge: true, embedUrl: "https://x.org/a.pdf" })?.kind).toBe("document");
  });
});
