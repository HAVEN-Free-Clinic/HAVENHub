import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { renderEmail } from "./renderEmail";

beforeEach(resetDb);

describe("renderEmail", () => {
  it("throws on an unknown template key", async () => {
    await expect(renderEmail("nope", {})).rejects.toThrow(/Unknown email template/);
  });

  it("uses the code default when no override exists and wraps in the passthrough layout", async () => {
    // 'layout' is a real descriptor; rendering it with a body var yields the body unchanged.
    const out = await renderEmail("layout", { body: "<p>hi</p>", subject: "S" });
    expect(out.subject).toBe("S");
    expect(out.html).toBe("<p>hi</p>");
  });

  it("prefers a DB override over the code default", async () => {
    await prisma.emailTemplate.create({
      data: { key: "layout", subject: "OVR {{ subject }}", body: "<x>{{{ body }}}</x>" },
    });
    const out = await renderEmail("layout", { body: "B", subject: "S" });
    expect(out.subject).toBe("OVR S");
    expect(out.html).toBe("<x>B</x>");
  });
});
