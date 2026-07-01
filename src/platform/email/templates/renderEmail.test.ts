import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { setSetting } from "@/platform/settings/service";
import { renderEmail, renderInlineEmail } from "./renderEmail";

beforeEach(resetDb);

describe("renderEmail", () => {
  it("throws on an unknown template key", async () => {
    await expect(renderEmail("nope", {})).rejects.toThrow(/Unknown email template/);
  });

  it("uses the code default when no override exists and wraps the body in the branded layout", async () => {
    // 'layout' is a real descriptor; its default is the branded shell with a {{{ body }}} slot.
    const out = await renderEmail("layout", { body: "<p>hi</p>", subject: "S" });
    expect(out.subject).toBe("S");
    // The branded shell injects the body verbatim and is a full HTML document.
    expect(out.html).toContain("<p>hi</p>");
    expect(out.html).toContain("<!DOCTYPE html>");
    expect(out.html).toContain("HAVEN Free Clinic");
  });

  it("prefers a DB override over the code default", async () => {
    await prisma.emailTemplate.create({
      data: { key: "layout", subject: "OVR {{ subject }}", body: "<x>{{{ body }}}</x>" },
    });
    const out = await renderEmail("layout", { body: "B", subject: "S" });
    expect(out.subject).toBe("OVR S");
    expect(out.html).toBe("<x>B</x>");
  });

  it("renderInlineEmail renders inline subject/body and wraps in the layout", async () => {
    const out = await renderInlineEmail(
      { subject: "Hi {{ firstName }}", body: "<p>Hello {{ name }}</p>" },
      { firstName: "Sam", name: "Sam Rivera" },
    );
    expect(out.subject).toBe("Hi Sam");
    expect(out.html).toContain("<p>Hello Sam Rivera</p>");
    expect(out.html).toContain("HAVEN Free Clinic"); // wrapped in branded layout
  });

  it("uses the default Yale blue in the layout when brandColor is unset", async () => {
    const out = await renderEmail("layout", { body: "<p>hi</p>", subject: "S" });
    expect(out.html).toContain("#00356b");
  });

  it("injects the configured branding.brandColor into the layout shell", async () => {
    await setSetting("branding.brandColor", "#0a7d3c", null);
    const out = await renderEmail("layout", { body: "<p>hi</p>", subject: "S" });
    expect(out.html).toContain("#0a7d3c");
    expect(out.html).not.toContain("#00356b");
  });

  it("renderInlineEmail honors the configured branding.brandColor in the layout", async () => {
    await setSetting("branding.brandColor", "#0a7d3c", null);
    const out = await renderInlineEmail(
      { subject: "S", body: "<p>hi</p>" },
      {},
    );
    expect(out.html).toContain("#0a7d3c");
    expect(out.html).not.toContain("#00356b");
  });
});
