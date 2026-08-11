import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { normalizePhoto } from "./normalize";
import { PHOTO_SIZE, PhotoError } from "./shared";

/** A solid-colour test image of the given dimensions. */
async function image(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
}

describe("normalizePhoto", () => {
  it("produces a square WebP at PHOTO_SIZE from a landscape source", async () => {
    const out = await normalizePhoto(await image(1200, 600));
    const meta = await sharp(out).metadata();

    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(PHOTO_SIZE);
    expect(meta.height).toBe(PHOTO_SIZE);
  });

  it("produces a square WebP at PHOTO_SIZE from a portrait source", async () => {
    const out = await normalizePhoto(await image(600, 1200));
    const meta = await sharp(out).metadata();

    expect(meta.width).toBe(PHOTO_SIZE);
    expect(meta.height).toBe(PHOTO_SIZE);
  });

  it("upscales a source smaller than PHOTO_SIZE", async () => {
    const out = await normalizePhoto(await image(64, 64));
    const meta = await sharp(out).metadata();

    expect(meta.width).toBe(PHOTO_SIZE);
    expect(meta.height).toBe(PHOTO_SIZE);
  });

  it("strips EXIF metadata", async () => {
    const withExif = await sharp(await image(800, 800))
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const meta = await sharp(await normalizePhoto(withExif)).metadata();

    expect(meta.orientation).toBeUndefined();
  });

  it("throws PhotoError on bytes that are not an image", async () => {
    await expect(normalizePhoto(Buffer.from("this is not an image"))).rejects.toBeInstanceOf(
      PhotoError
    );
  });
});
