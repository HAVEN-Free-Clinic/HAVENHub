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

  it("auto-orients using EXIF before cropping, and strips the tag from the output", async () => {
    // A landscape source, left half red and right half blue, tagged with
    // EXIF orientation 6 ("rotate 90deg clockwise to display correctly").
    // If normalizePhoto honours that tag, the crop that follows sees a
    // portrait image with red on top and blue on the bottom: what was on
    // the left rotates to the top. If it does not, the crop still sees the
    // original left/right split. Sampling actual output pixels tells the
    // two cases apart, unlike checking dimensions or metadata alone, which
    // stay identical either way.
    const width = 800;
    const height = 400;
    const half = width / 2;

    const blueHalf = await sharp({
      create: { width: half, height, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer();

    const base = await sharp({
      create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .composite([{ input: blueHalf, left: half, top: 0 }])
      .png()
      .toBuffer();

    const withExif = await sharp(base).withMetadata({ orientation: 6 }).toBuffer();

    const out = await normalizePhoto(withExif);
    const outMeta = await sharp(out).metadata();
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });

    function pixelAt(x: number, y: number): { r: number; g: number; b: number } {
      const idx = (y * info.width + x) * info.channels;
      return { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
    }

    // Sampled well off the vertical midline, so this reads purely as a
    // top/bottom check: it stays constant across x in both the rotated and
    // unrotated case, and only flips with y once rotation has happened.
    const upper = pixelAt(128, 128);
    const lower = pixelAt(128, 384);

    expect(upper.r).toBeGreaterThan(upper.b);
    expect(lower.b).toBeGreaterThan(lower.r);
    expect(outMeta.orientation).toBeUndefined();
  });

  it("throws PhotoError on bytes that are not an image", async () => {
    await expect(normalizePhoto(Buffer.from("this is not an image"))).rejects.toBeInstanceOf(
      PhotoError
    );
  });
});
