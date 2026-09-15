import { describe, it, expect } from "vitest";
import { fitWithin, PHOTO_UPLOAD_MAX_EDGE } from "./photo-downscale";

describe("fitWithin", () => {
  it("scales a portrait phone photo so its long edge fits, keeping the aspect ratio", () => {
    expect(fitWithin(3024, 4032, PHOTO_UPLOAD_MAX_EDGE)).toEqual({ width: 1200, height: 1600 });
  });

  it("scales a landscape photo by its width", () => {
    expect(fitWithin(4000, 2000, 1600)).toEqual({ width: 1600, height: 800 });
  });

  it("never enlarges a photo that already fits", () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });
});
