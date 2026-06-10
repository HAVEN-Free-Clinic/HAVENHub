import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache } from "@/platform/settings/service";
import { HavenLogo } from "./haven-logo";

beforeEach(async () => { await resetDb(); _resetSettingsCache(); });

describe("HavenLogo", () => {
  it("points the mask at the branding route with the default version", async () => {
    const el = await HavenLogo({ className: "h-8" });
    const style = el.props.style as { maskImage: string };
    expect(style.maskImage).toBe("url(/api/branding/logo?v=0)");
  });

  it("uses the stored logo version as a cache-buster", async () => {
    await prisma.setting.create({
      data: { key: "branding.logo", value: { contentType: "image/png", version: 3 } },
    });
    _resetSettingsCache();
    const el = await HavenLogo({});
    const style = el.props.style as { maskImage: string };
    expect(style.maskImage).toBe("url(/api/branding/logo?v=3)");
  });
});
