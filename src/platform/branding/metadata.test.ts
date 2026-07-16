import { describe, it, expect, vi, beforeEach } from "vitest";

const getSetting = vi.fn();
vi.mock("@/platform/settings/service", () => ({
  getSetting: (key: string) => getSetting(key),
}));

import { buildPageMetadata, moduleMetadata } from "./metadata";

beforeEach(() => {
  getSetting.mockReset();
  getSetting.mockImplementation((key: string) => {
    const values: Record<string, unknown> = {
      "branding.appName": "HAVEN Hub",
      "branding.orgName": "HAVEN Free Clinic",
      "app.baseUrl": "https://hub.example.org",
    };
    return Promise.resolve(values[key]);
  });
});

describe("buildPageMetadata", () => {
  it("root call sets a title template and app-name OG title", async () => {
    const m = await buildPageMetadata();
    expect(m.title).toEqual({ default: "HAVEN Hub", template: "%s · HAVEN Hub" });
    expect(m.openGraph?.title).toBe("HAVEN Hub");
    expect(m.description).toBe("The unified platform for HAVEN Free Clinic");
  });

  it("child call composes the OG title and keeps a raw tab title", async () => {
    const m = await buildPageMetadata({ title: "Learning", description: "Courses" });
    expect(m.title).toBe("Learning");
    expect(m.openGraph?.title).toBe("Learning · HAVEN Hub");
    expect(m.twitter?.title).toBe("Learning · HAVEN Hub");
    expect(m.description).toBe("Courses");
  });

  it("standalone title opts out of the app-name suffix in tab and card", async () => {
    const m = await buildPageMetadata({
      title: "HAVEN Application Portal",
      description: "Apply to HAVEN Free Clinic",
      standalone: true,
    });
    expect(m.title).toEqual({ absolute: "HAVEN Application Portal" });
    expect(m.openGraph?.title).toBe("HAVEN Application Portal");
    expect(m.twitter?.title).toBe("HAVEN Application Portal");
    expect(m.description).toBe("Apply to HAVEN Free Clinic");
  });

  it("resolves metadataBase from app.baseUrl", async () => {
    const m = await buildPageMetadata();
    expect(m.metadataBase?.toString()).toBe("https://hub.example.org/");
  });

  it("uses the 1200x630 physicians JPG for OG and Twitter", async () => {
    const m = await buildPageMetadata();
    const img = (m.openGraph?.images as Array<{ url: string; width: number; height: number }>)[0];
    expect(img).toMatchObject({ url: "/brand/og-image.jpg", width: 1200, height: 630 });
    // Next's Metadata["twitter"] type is a union whose base variant has no
    // "card" field, so TypeScript can't narrow it on a plain optional-chain
    // read; assert through a small local shape instead.
    expect((m.twitter as { card?: string } | undefined)?.card).toBe("summary_large_image");
    expect((m.twitter?.images as string[])[0]).toBe("/brand/og-image.jpg");
  });
});

describe("moduleMetadata", () => {
  it("reuses the module registry title and description", async () => {
    const m = await moduleMetadata("learning");
    expect(m.title).toBe("Learning");
    expect(m.openGraph?.title).toBe("Learning · HAVEN Hub");
    expect(m.description).toBe("Self-paced training courses assigned by department");
  });
});
